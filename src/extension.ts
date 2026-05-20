import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn']);
const MARKDOWN_PREVIEW_EDITOR = 'vscode.markdown.preview.editor';
const MARKDOWN_EDITOR_ASSOCIATION = '*.md';
const COLLAPSE_ALL_COMMAND = 'workbench.actions.treeView.markdownBrowser.files.collapseAll';
const MARKDOWN_BROWSER_VIEW_TYPE = 'markdownBrowser.preview';
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

interface MarkdownLocation {
  uri: vscode.Uri;
  fragment?: string;
}

interface OpenLinkMessage {
  type: 'openLink';
  href: string;
  openInNewTab?: boolean;
}

interface HistoryMessage {
  type: 'back' | 'forward';
}

type WebviewMessage = OpenLinkMessage | HistoryMessage;
type LinkTarget =
  | { kind: 'markdown'; location: MarkdownLocation }
  | { kind: 'file' | 'folder' | 'external'; uri: vscode.Uri }
  | { kind: 'missing' };

class MarkdownBrowserPreview {
  private panel?: vscode.WebviewPanel;
  private current?: MarkdownLocation;
  private history: MarkdownLocation[] = [];
  private historyIndex = -1;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async open(uri: vscode.Uri): Promise<void> {
    await this.navigate({ uri }, true);
  }

  public async back(): Promise<void> {
    await this.goBack();
  }

  public async forward(): Promise<void> {
    await this.goForward();
  }

  public async refreshIfCurrent(uri: vscode.Uri): Promise<void> {
    if (!this.panel || !this.current || !sameUri(this.current.uri, uri)) {
      return;
    }

    const panel = this.panel;
    const location = this.current;
    const html = await this.render(location);

    if (this.panel !== panel || !this.current || !sameLocation(this.current, location)) {
      return;
    }

    panel.title = path.basename(location.uri.fsPath);
    panel.webview.html = html;
    await this.updateNavigationContext();
  }

  public dispose(): void {
    this.panel?.dispose();
    this.disposables.splice(0).forEach((disposable) => disposable.dispose());
    void this.updateNavigationContext();
  }

  private async navigate(location: MarkdownLocation, pushHistory: boolean): Promise<void> {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        MARKDOWN_BROWSER_VIEW_TYPE,
        'Markdown Browser',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: getWebviewResourceRoots(this.context, location.uri)
        }
      );

      this.disposables.push(
        this.panel.onDidDispose(() => {
          this.panel = undefined;
          this.current = undefined;
          this.history = [];
          this.historyIndex = -1;
          void this.updateNavigationContext();
        }),
        this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
          void this.handleMessage(message);
        })
      );
    }

    this.current = location;

    if (pushHistory) {
      this.pushHistory(location);
    }

    this.panel.title = path.basename(location.uri.fsPath);
    this.panel.webview.html = await this.render(location);
    this.panel.reveal(vscode.ViewColumn.Active, true);
    await this.updateNavigationContext();
  }

  private pushHistory(location: MarkdownLocation): void {
    const current = this.history[this.historyIndex];

    if (current && sameLocation(current, location)) {
      return;
    }

    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(location);
    this.historyIndex = this.history.length - 1;
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === 'back') {
      await this.goBack();
      return;
    }

    if (message.type === 'forward') {
      await this.goForward();
      return;
    }

    if (message.type === 'openLink') {
      await this.openLink(message.href, message.openInNewTab === true);
    }
  }

  private async goBack(): Promise<void> {
    if (this.historyIndex <= 0) {
      return;
    }

    this.historyIndex -= 1;
    await this.navigate(this.history[this.historyIndex], false);
  }

  private async goForward(): Promise<void> {
    if (this.historyIndex >= this.history.length - 1) {
      return;
    }

    this.historyIndex += 1;
    await this.navigate(this.history[this.historyIndex], false);
  }

  private async updateNavigationContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'markdownBrowser.previewCanGoBack', this.historyIndex > 0);
    await vscode.commands.executeCommand(
      'setContext',
      'markdownBrowser.previewCanGoForward',
      this.historyIndex >= 0 && this.historyIndex < this.history.length - 1
    );
  }

  private async openLink(href: string, openInNewTab: boolean): Promise<void> {
    if (!this.current) {
      return;
    }

    const target = await resolveMarkdownLink(this.current.uri, href);

    if (openInNewTab) {
      await openLinkTargetInNewTab(target);
      return;
    }

    if (target.kind === 'markdown') {
      await this.navigate(target.location, true);
      return;
    }

    if (target.kind === 'file') {
      await vscode.commands.executeCommand('vscode.open', target.uri);
      return;
    }

    if (target.kind === 'folder') {
      await vscode.commands.executeCommand('revealInExplorer', target.uri);
      return;
    }

    if (target.kind === 'external') {
      await vscode.env.openExternal(target.uri);
    }
  }

  private async render(location: MarkdownLocation): Promise<string> {
    const source = await readUtf8File(location.uri);
    const rendered = await renderMarkdown(source);
    const body = rewriteLocalImageSources(rendered, location.uri, this.panel!.webview);
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.panel!.webview.cspSource} https: data:; style-src ${this.panel!.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      box-sizing: border-box;
      max-width: 920px;
      margin: 0 auto;
      padding: 28px 34px 56px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.6;
    }

    a { color: var(--vscode-textLink-foreground); }
    a:hover { color: var(--vscode-textLink-activeForeground); }
    img { max-width: 100%; height: auto; }
    pre {
      overflow-x: auto;
      padding: 12px;
      border-radius: 6px;
      background: var(--vscode-textCodeBlock-background);
    }
    code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
      padding: 0.1em 0.3em;
    }
    pre code { padding: 0; background: transparent; }
    blockquote {
      margin-left: 0;
      padding-left: 16px;
      border-left: 3px solid var(--vscode-textBlockQuote-border);
      color: var(--vscode-textBlockQuote-foreground);
    }
    table { border-collapse: collapse; }
    th, td {
      border: 1px solid var(--vscode-editorWidget-border);
      padding: 6px 10px;
    }
  </style>
</head>
<body>
  <main class="markdown-body">
${body}
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialFragment = ${JSON.stringify(location.fragment ?? '')};

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const anchor = target?.closest('a');
      if (!anchor) {
        return;
      }

      const href = anchor.getAttribute('data-href') || anchor.getAttribute('href');
      if (!href) {
        return;
      }

      event.preventDefault();
      vscode.postMessage({
        type: 'openLink',
        href,
        openInNewTab: event.metaKey || event.ctrlKey
      });
    });

    const pressedNavigationButtons = new Set();

    function isNavigationMouseButton(event) {
      return event.button === 3 || event.button === 4;
    }

    function consumeNavigationMouseEvent(event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }

    window.addEventListener('mousedown', (event) => {
      if (!isNavigationMouseButton(event)) {
        return;
      }

      consumeNavigationMouseEvent(event);
      pressedNavigationButtons.add(event.button);
    }, true);

    window.addEventListener('mouseup', (event) => {
      if (!isNavigationMouseButton(event)) {
        return;
      }

      consumeNavigationMouseEvent(event);

      if (pressedNavigationButtons.has(event.button)) {
        vscode.postMessage({ type: event.button === 3 ? 'back' : 'forward' });
      }

      pressedNavigationButtons.delete(event.button);
    }, true);

    window.addEventListener('auxclick', (event) => {
      if (isNavigationMouseButton(event)) {
        consumeNavigationMouseEvent(event);
        pressedNavigationButtons.delete(event.button);
      }
    }, true);

    window.addEventListener('blur', () => {
      pressedNavigationButtons.clear();
    });
    document.addEventListener('mouseleave', () => {
      pressedNavigationButtons.clear();
    });

    window.addEventListener('DOMContentLoaded', () => {
      if (!initialFragment) {
        return;
      }

      let id = initialFragment;
      try {
        id = decodeURIComponent(initialFragment);
      } catch {}
      const target = document.getElementById(id) || document.getElementById(initialFragment);
      target?.scrollIntoView();
    });
  </script>
</body>
</html>`;
  }
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
  const markdownPreview = new MarkdownBrowserPreview(context);
  const treeView = vscode.window.createTreeView('markdownBrowser.files', {
    treeDataProvider: provider
  });
  let treeExpanded = false;
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.viewMode', initialViewMode);
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.showGitignoredFiles', initialShowGitignoredFiles);
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.previewCanGoBack', false);
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.previewCanGoForward', false);
  void updateHasGitWorkspaceContext();

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{md,markdown,mdown,mkd,mkdn}');
  const refresh = () => {
    treeExpanded = false;
    void vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
    provider.refresh();
    void updateHasGitWorkspaceContext();
  };
  const refreshChangedMarkdown = (uri: vscode.Uri) => {
    refresh();
    void markdownPreview.refreshIfCurrent(uri);
  };

  context.subscriptions.push(
    treeView,
    markdownPreview,
    watcher,
    watcher.onDidCreate(refresh),
    watcher.onDidChange(refreshChangedMarkdown),
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
    vscode.commands.registerCommand('markdownBrowser.openPreview', (uri?: vscode.Uri) => openMarkdownPreview(markdownPreview, uri)),
    vscode.commands.registerCommand('markdownBrowser.navigateBack', () => markdownPreview.back()),
    vscode.commands.registerCommand('markdownBrowser.navigateForward', () => markdownPreview.forward()),
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

async function openMarkdownPreview(markdownPreview: MarkdownBrowserPreview, uri?: vscode.Uri): Promise<void> {
  if (!uri) {
    uri = vscode.window.activeTextEditor?.document.uri;
  }

  if (!uri || !isMarkdownFile(uri.fsPath)) {
    return;
  }

  await markdownPreview.open(uri);
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

async function openLinkTargetInNewTab(target: LinkTarget): Promise<void> {
  if (target.kind === 'markdown') {
    await vscode.commands.executeCommand(
      'vscode.openWith',
      target.location.uri.with({ fragment: target.location.fragment }),
      MARKDOWN_PREVIEW_EDITOR,
      {
        preview: false,
        viewColumn: vscode.ViewColumn.Active
      }
    );
    return;
  }

  if (target.kind === 'file') {
    await vscode.commands.executeCommand('vscode.open', target.uri, {
      preview: false,
      viewColumn: vscode.ViewColumn.Active
    });
    return;
  }

  if (target.kind === 'folder') {
    await vscode.commands.executeCommand('revealInExplorer', target.uri);
    return;
  }

  if (target.kind === 'external') {
    await vscode.env.openExternal(target.uri);
  }
}

async function readUtf8File(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

async function renderMarkdown(source: string): Promise<string> {
  try {
    return await vscode.commands.executeCommand<string>('markdown.api.render', source);
  } catch {
    return `<pre>${escapeHtml(source)}</pre>`;
  }
}

async function resolveMarkdownLink(sourceUri: vscode.Uri, href: string): Promise<LinkTarget> {
  const trimmedHref = href.trim();

  if (!trimmedHref) {
    return { kind: 'missing' };
  }

  if (trimmedHref.startsWith('#')) {
    return {
      kind: 'markdown',
      location: {
        uri: sourceUri,
        fragment: trimmedHref.slice(1)
      }
    };
  }

  const explicitScheme = /^[a-z][a-z0-9+.-]*:/i.exec(trimmedHref)?.[0]?.slice(0, -1).toLowerCase();

  if (explicitScheme && explicitScheme !== 'file') {
    return {
      kind: 'external',
      uri: vscode.Uri.parse(trimmedHref)
    };
  }

  const [rawPath, rawFragment] = splitHref(trimmedHref);
  const targetUri = explicitScheme === 'file'
    ? vscode.Uri.parse(trimmedHref).with({ fragment: '' })
    : vscode.Uri.file(path.resolve(path.dirname(sourceUri.fsPath), decodeUriComponentSafe(rawPath)));
  const resolvedUri = await resolveExistingLinkedUri(targetUri);

  if (!resolvedUri) {
    return { kind: 'missing' };
  }

  const stat = await statUri(resolvedUri);

  if (!stat) {
    return { kind: 'missing' };
  }

  if (stat.type === vscode.FileType.Directory) {
    return { kind: 'folder', uri: resolvedUri };
  }

  if (isMarkdownFile(resolvedUri.fsPath)) {
    return {
      kind: 'markdown',
      location: {
        uri: resolvedUri,
        fragment: rawFragment
      }
    };
  }

  return { kind: 'file', uri: resolvedUri };
}

async function resolveExistingLinkedUri(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (await statUri(uri)) {
    return uri;
  }

  if (path.extname(uri.fsPath)) {
    return undefined;
  }

  for (const extension of MARKDOWN_EXTENSIONS) {
    const candidate = vscode.Uri.file(`${uri.fsPath}${extension}`);

    if (await statUri(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function statUri(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try {
    return await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
}

function splitHref(href: string): [string, string | undefined] {
  const hashIndex = href.indexOf('#');

  if (hashIndex === -1) {
    return [href, undefined];
  }

  return [href.slice(0, hashIndex), href.slice(hashIndex + 1)];
}

function rewriteLocalImageSources(html: string, sourceUri: vscode.Uri, webview: vscode.Webview): string {
  return html.replace(/<img\b([^>]*?)(\s)src=(["'])([^"']+)\3/gi, (match, before: string, space: string, quote: string, src: string) => {
    const rewrittenSrc = rewriteLocalResourceSource(src, sourceUri, webview);
    return `<img${before}${space}src=${quote}${escapeAttribute(rewrittenSrc)}${quote}`;
  });
}

function rewriteLocalResourceSource(src: string, sourceUri: vscode.Uri, webview: vscode.Webview): string {
  if (!src || src.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|data:)/i.test(src)) {
    return src;
  }

  const [rawPath] = splitHref(src);
  const resourceUri = vscode.Uri.file(path.resolve(path.dirname(sourceUri.fsPath), decodeUriComponentSafe(rawPath)));
  return webview.asWebviewUri(resourceUri).toString();
}

function getWebviewResourceRoots(context: vscode.ExtensionContext, uri: vscode.Uri): vscode.Uri[] {
  return [
    context.extensionUri,
    ...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? [vscode.Uri.file(path.dirname(uri.fsPath))])
  ];
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}

function decodeUriComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;');
}

function sameLocation(a: MarkdownLocation, b: MarkdownLocation): boolean {
  return a.uri.toString() === b.uri.toString() && a.fragment === b.fragment;
}

function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString() === b.toString();
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
