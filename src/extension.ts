import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn']);
const MARKDOWN_PREVIEW_EDITOR = 'vscode.markdown.preview.editor';
const MARKDOWN_EDITOR_ASSOCIATION = '*.md';
const COLLAPSE_ALL_COMMAND = 'workbench.actions.treeView.markdownBrowser.files.collapseAll';
const VIEW_MODE_STORAGE_KEY = 'markdownBrowser.viewMode';
const SHOW_GITIGNORED_STORAGE_KEY = 'markdownBrowser.showGitignoredFiles';
const execFileAsync = promisify(execFile);
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.vscode',
  '.venv',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage'
]);

type MarkdownNodeKind = 'workspace' | 'folder' | 'file';
type MarkdownViewMode = 'tree' | 'list';

interface GitWorkspaceState {
  hasGitWorkspace: boolean;
  ignoredFilesByWorkspace: Map<string, Set<string>>;
}

class MarkdownNode extends vscode.TreeItem {
  public constructor(
    public readonly uri: vscode.Uri,
    public readonly kind: MarkdownNodeKind,
    public readonly workspaceFolder?: vscode.WorkspaceFolder,
    label?: string,
    description?: string
  ) {
    super(
      label ?? (kind === 'workspace' && workspaceFolder ? workspaceFolder.name : path.basename(uri.fsPath)),
      kind === 'file' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed
    );

    this.resourceUri = uri;
    this.id = `${kind}:${uri.toString()}`;
    this.contextValue = `markdownBrowser.${kind}`;
    this.description = description;

    if (kind === 'file') {
      this.command = {
        command: 'markdownBrowser.openPreview',
        title: 'Open Markdown Preview',
        arguments: [uri]
      };
    }
  }
}

class MarkdownBrowserProvider implements vscode.TreeDataProvider<MarkdownNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<MarkdownNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private gitState?: Promise<GitWorkspaceState>;

  public constructor(
    private viewMode: MarkdownViewMode,
    private showGitignoredFiles: boolean
  ) {}

  public setViewMode(viewMode: MarkdownViewMode): void {
    this.viewMode = viewMode;
    this.refresh();
  }

  public setShowGitignoredFiles(showGitignoredFiles: boolean): void {
    this.showGitignoredFiles = showGitignoredFiles;
    this.refresh();
  }

  public refresh(): void {
    this.gitState = undefined;
    this.onDidChangeTreeDataEmitter.fire();
  }

  public getTreeItem(element: MarkdownNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: MarkdownNode): Promise<MarkdownNode[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return [];
    }

    if (!element) {
      if (this.viewMode === 'list') {
        return this.getListChildren();
      }

      if (vscode.workspace.workspaceFolders.length === 1) {
        const [folder] = vscode.workspace.workspaceFolders;
        return this.getDirectoryChildren(folder.uri, folder);
      }

      return vscode.workspace.workspaceFolders.map((folder) => new MarkdownNode(folder.uri, 'workspace', folder));
    }

    return this.getDirectoryChildren(element.uri, element.workspaceFolder);
  }

  public getParent(element: MarkdownNode): vscode.ProviderResult<MarkdownNode> {
    if (!element.workspaceFolder || element.kind === 'workspace') {
      return undefined;
    }

    const workspacePath = normalizePath(element.workspaceFolder.uri.fsPath);
    const parentPath = normalizePath(path.dirname(element.uri.fsPath));

    if (parentPath === workspacePath) {
      return vscode.workspace.workspaceFolders?.length === 1
        ? undefined
        : new MarkdownNode(element.workspaceFolder.uri, 'workspace', element.workspaceFolder);
    }

    if (!isWithinPath(parentPath, workspacePath)) {
      return undefined;
    }

    return new MarkdownNode(vscode.Uri.file(parentPath), 'folder', element.workspaceFolder);
  }

  public async getExpandableNodes(): Promise<MarkdownNode[]> {
    if (!vscode.workspace.workspaceFolders?.length || this.viewMode === 'list') {
      return [];
    }

    const nodes: MarkdownNode[] = [];

    if (vscode.workspace.workspaceFolders.length === 1) {
      const [folder] = vscode.workspace.workspaceFolders;
      await this.collectExpandableNodes(folder.uri, folder, nodes);
      return nodes;
    }

    for (const folder of vscode.workspace.workspaceFolders) {
      const workspaceNode = new MarkdownNode(folder.uri, 'workspace', folder);
      nodes.push(workspaceNode);
      await this.collectExpandableNodes(folder.uri, folder, nodes);
    }

    return nodes;
  }

  private async getListChildren(): Promise<MarkdownNode[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const includeWorkspaceName = folders.length > 1;
    const files: MarkdownNode[] = [];

    for (const folder of folders) {
      files.push(...await this.getFlattenedDirectoryFiles(folder.uri, folder, includeWorkspaceName));
    }

    return files;
  }

  private async getFlattenedDirectoryFiles(
    uri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder,
    includeWorkspaceName: boolean
  ): Promise<MarkdownNode[]> {
    const files: MarkdownNode[] = [];
    const children = await this.getDirectoryChildren(uri, workspaceFolder);

    for (const child of children) {
      if (child.kind === 'folder') {
        files.push(...await this.getFlattenedDirectoryFiles(child.uri, workspaceFolder, includeWorkspaceName));
      } else if (child.kind === 'file') {
        files.push(createListFileNode(child.uri, workspaceFolder, includeWorkspaceName));
      }
    }

    return files;
  }

  private async getDirectoryChildren(
    uri: vscode.Uri,
    workspaceFolder?: vscode.WorkspaceFolder
  ): Promise<MarkdownNode[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return [];
    }

    const nodes: MarkdownNode[] = [];

    await Promise.all(
      entries.map(async ([name, fileType]) => {
        const childUri = vscode.Uri.joinPath(uri, name);

        if (
          fileType === vscode.FileType.File
          && isMarkdownFile(name)
          && await this.isVisibleMarkdownFile(childUri, workspaceFolder)
        ) {
          nodes.push(new MarkdownNode(childUri, 'file', workspaceFolder));
          return;
        }

        if (
          fileType === vscode.FileType.Directory
          && !isExcludedDirectory(name)
          && await this.containsMarkdown(childUri, workspaceFolder)
        ) {
          nodes.push(new MarkdownNode(childUri, 'folder', workspaceFolder));
        }
      })
    );

    return nodes.sort(compareNodes);
  }

  private async collectExpandableNodes(
    uri: vscode.Uri,
    workspaceFolder: vscode.WorkspaceFolder,
    nodes: MarkdownNode[]
  ): Promise<void> {
    const children = await this.getDirectoryChildren(uri, workspaceFolder);

    for (const child of children) {
      if (child.kind === 'folder') {
        nodes.push(child);
        await this.collectExpandableNodes(child.uri, workspaceFolder, nodes);
      }
    }
  }

  private async containsMarkdown(
    uri: vscode.Uri,
    workspaceFolder?: vscode.WorkspaceFolder
  ): Promise<boolean> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);

      for (const [name, fileType] of entries) {
        const childUri = vscode.Uri.joinPath(uri, name);

        if (
          fileType === vscode.FileType.File
          && isMarkdownFile(name)
          && await this.isVisibleMarkdownFile(childUri, workspaceFolder)
        ) {
          return true;
        }

        if (
          fileType === vscode.FileType.Directory
          && !isExcludedDirectory(name)
          && await this.containsMarkdown(childUri, workspaceFolder)
        ) {
          return true;
        }
      }
    } catch {
      return false;
    }

    return false;
  }

  private async isVisibleMarkdownFile(
    uri: vscode.Uri,
    workspaceFolder?: vscode.WorkspaceFolder
  ): Promise<boolean> {
    if (this.showGitignoredFiles || !workspaceFolder) {
      return true;
    }

    const gitState = await this.getGitState();
    const ignoredFiles = gitState.ignoredFilesByWorkspace.get(workspaceFolder.uri.toString());
    return !ignoredFiles?.has(normalizePath(uri.fsPath));
  }

  private getGitState(): Promise<GitWorkspaceState> {
    this.gitState ??= getGitWorkspaceState();
    return this.gitState;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const initialViewMode = normalizeViewMode(context.workspaceState.get<MarkdownViewMode>(VIEW_MODE_STORAGE_KEY));
  const initialShowGitignoredFiles = context.workspaceState.get<boolean>(SHOW_GITIGNORED_STORAGE_KEY, false);
  const provider = new MarkdownBrowserProvider(initialViewMode, initialShowGitignoredFiles);
  const treeView = vscode.window.createTreeView('markdownBrowser.files', {
    treeDataProvider: provider
  });
  let treeExpanded = false;
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.viewMode', initialViewMode);
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.showGitignoredFiles', initialShowGitignoredFiles);
  void updateHasGitWorkspaceContext();

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{md,markdown,mdown,mkd,mkdn}');
  const refresh = () => {
    treeExpanded = false;
    void vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
    provider.refresh();
    void updateHasGitWorkspaceContext();
  };

  context.subscriptions.push(
    treeView,
    watcher,
    watcher.onDidCreate(refresh),
    watcher.onDidChange(refresh),
    watcher.onDidDelete(refresh),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('markdownBrowser.excludedDirectories')) {
        refresh();
      }
    }),
    vscode.commands.registerCommand('markdownBrowser.refresh', refresh),
    vscode.commands.registerCommand('markdownBrowser.expandAll', async () => {
      await expandAll(treeView, provider);
      treeExpanded = true;
      await vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
    }),
    vscode.commands.registerCommand('markdownBrowser.collapseAll', async () => {
      await vscode.commands.executeCommand(COLLAPSE_ALL_COMMAND);
      treeExpanded = false;
      await vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
    }),
    vscode.commands.registerCommand('markdownBrowser.openPreview', openMarkdownPreview),
    vscode.commands.registerCommand('markdownBrowser.showListView', async () => {
      treeExpanded = false;
      await vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
      await updateViewMode(context, provider, 'list');
    }),
    vscode.commands.registerCommand('markdownBrowser.showTreeView', async () => {
      treeExpanded = false;
      await vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
      await updateViewMode(context, provider, 'tree');
    }),
    vscode.commands.registerCommand('markdownBrowser.showGitignoredFiles', () => updateGitignoredVisibility(context, provider, true)),
    vscode.commands.registerCommand('markdownBrowser.hideGitignoredFiles', () => updateGitignoredVisibility(context, provider, false)),
    vscode.commands.registerCommand('markdownBrowser.toggleExplorerPreviewOpen', toggleExplorerPreviewOpen)
  );
}

export function deactivate(): void {
  // No cleanup needed; VS Code disposes subscriptions registered during activation.
}

async function openMarkdownPreview(uri?: vscode.Uri): Promise<void> {
  if (!uri) {
    uri = vscode.window.activeTextEditor?.document.uri;
  }

  if (!uri || !isMarkdownFile(uri.fsPath)) {
    return;
  }

  await vscode.commands.executeCommand(
    'vscode.openWith',
    uri,
    MARKDOWN_PREVIEW_EDITOR,
    vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active
  );
}

async function updateViewMode(
  context: vscode.ExtensionContext,
  provider: MarkdownBrowserProvider,
  viewMode: MarkdownViewMode
): Promise<void> {
  await context.workspaceState.update(VIEW_MODE_STORAGE_KEY, viewMode);
  await vscode.commands.executeCommand('setContext', 'markdownBrowser.viewMode', viewMode);
  provider.setViewMode(viewMode);
}

async function updateGitignoredVisibility(
  context: vscode.ExtensionContext,
  provider: MarkdownBrowserProvider,
  showGitignoredFiles: boolean
): Promise<void> {
  await context.workspaceState.update(SHOW_GITIGNORED_STORAGE_KEY, showGitignoredFiles);
  await vscode.commands.executeCommand('setContext', 'markdownBrowser.showGitignoredFiles', showGitignoredFiles);
  provider.setShowGitignoredFiles(showGitignoredFiles);
}

async function expandAll(
  treeView: vscode.TreeView<MarkdownNode>,
  provider: MarkdownBrowserProvider
): Promise<void> {
  const nodes = await provider.getExpandableNodes();

  for (const node of nodes) {
    try {
      await treeView.reveal(node, {
        expand: true,
        focus: false,
        select: false
      });
    } catch {
      // The tree can refresh while reveal is walking it; keep expanding the remaining nodes.
    }
  }
}

async function toggleExplorerPreviewOpen(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('workbench');
  const editorAssociations = {
    ...configuration.get<Record<string, string>>('editorAssociations', {})
  };
  const isEnabled = editorAssociations[MARKDOWN_EDITOR_ASSOCIATION] === MARKDOWN_PREVIEW_EDITOR;

  if (isEnabled) {
    delete editorAssociations[MARKDOWN_EDITOR_ASSOCIATION];
  } else {
    editorAssociations[MARKDOWN_EDITOR_ASSOCIATION] = MARKDOWN_PREVIEW_EDITOR;
  }

  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  await configuration.update('editorAssociations', editorAssociations, target);

  const scope = target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'user settings';
  const state = isEnabled ? 'disabled' : 'enabled';
  vscode.window.showInformationMessage(`Markdown preview is now ${state} as the default .md opener in ${scope}.`);
}

function isMarkdownFile(fileName: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function isExcludedDirectory(name: string): boolean {
  const configured = vscode.workspace
    .getConfiguration('markdownBrowser')
    .get<string[]>('excludedDirectories');

  return new Set(configured?.length ? configured : DEFAULT_EXCLUDED_DIRECTORIES).has(name);
}

function normalizeViewMode(viewMode: MarkdownViewMode | undefined): MarkdownViewMode {
  return viewMode === 'list' ? 'list' : 'tree';
}

async function updateHasGitWorkspaceContext(): Promise<void> {
  const { hasGitWorkspace } = await getGitWorkspaceState();
  await vscode.commands.executeCommand('setContext', 'markdownBrowser.hasGitWorkspace', hasGitWorkspace);
}

async function getGitWorkspaceState(): Promise<GitWorkspaceState> {
  const ignoredFilesByWorkspace = new Map<string, Set<string>>();
  let hasGitWorkspace = false;

  for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
    const ignoredFiles = await getIgnoredMarkdownFiles(workspaceFolder);
    hasGitWorkspace ||= ignoredFiles !== undefined;
    ignoredFilesByWorkspace.set(workspaceFolder.uri.toString(), ignoredFiles ?? new Set<string>());
  }

  return {
    hasGitWorkspace,
    ignoredFilesByWorkspace
  };
}

async function getIgnoredMarkdownFiles(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<Set<string> | undefined> {
  try {
    const repoRoot = (await execFileAsync('git', [
      '-C',
      workspaceFolder.uri.fsPath,
      'rev-parse',
      '--show-toplevel'
    ])).stdout.trim();
    const { stdout } = await execFileAsync(
      'git',
      [
        '-C',
        repoRoot,
        'ls-files',
        '--ignored',
        '--exclude-standard',
        '--others',
        '-z',
        '--',
        ...[...MARKDOWN_EXTENSIONS].flatMap((extension) => [
          `:(glob)*${extension}`,
          `:(glob)**/*${extension}`
        ])
      ],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const workspacePath = normalizePath(workspaceFolder.uri.fsPath);
    const ignoredFiles = new Set<string>();

    for (const relativePath of stdout.split('\0')) {
      if (!relativePath) {
        continue;
      }

      const ignoredPath = normalizePath(path.resolve(repoRoot, relativePath));

      if (ignoredPath === workspacePath || isWithinPath(ignoredPath, workspacePath)) {
        ignoredFiles.add(ignoredPath);
      }
    }

    return ignoredFiles;
  } catch {
    return undefined;
  }
}

function createListFileNode(
  uri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder,
  includeWorkspaceName: boolean
): MarkdownNode {
  const relativeFilePath = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
  const relativeDirectory = path.dirname(relativeFilePath);
  const descriptionParts = [];

  if (includeWorkspaceName) {
    descriptionParts.push(workspaceFolder.name);
  }

  if (relativeDirectory !== '.') {
    descriptionParts.push(relativeDirectory);
  }

  return new MarkdownNode(uri, 'file', workspaceFolder, path.basename(uri.fsPath), descriptionParts.join(path.sep));
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

function isWithinPath(candidatePath: string, parentPath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return !!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function compareNodes(a: MarkdownNode, b: MarkdownNode): number {
  if (a.kind === b.kind) {
    return a.label!.toString().localeCompare(b.label!.toString(), undefined, { sensitivity: 'base' });
  }

  return a.kind === 'file' ? 1 : -1;
}
