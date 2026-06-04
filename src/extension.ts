import * as path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn']);
const MARKDOWN_PREVIEW_EDITOR = 'markdownBrowser.previewEditor';
const MARKDOWN_EDITOR_ASSOCIATION = '*.md';
const COLLAPSE_ALL_COMMAND = 'workbench.actions.treeView.markdownBrowser.files.collapseAll';
const MARKDOWN_BROWSER_VIEW_TYPE = 'markdownBrowser.preview';
const VIEW_MODE_STORAGE_KEY = 'markdownBrowser.viewMode';
const SHOW_GITIGNORED_STORAGE_KEY = 'markdownBrowser.showGitignoredFiles';
const TREE_BUSY_CONTEXT = 'markdownBrowser.treeBusy';
const LINKED_FILES_MESSAGE_URI = vscode.Uri.parse('markdown-browser://linked-files/message');
const execFileAsync = promisify(execFile);
const FILE_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
});
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
type LinkedMarkdownNodeKind = 'file' | 'message';
type MarkdownViewMode = 'tree' | 'list';

interface GitWorkspaceState {
  hasGitWorkspace: boolean;
  ignoredFilesByWorkspace: Map<string, Set<string>>;
}

interface MarkdownLocation {
  uri: vscode.Uri;
  fragment?: string;
}

interface FrontmatterEntry {
  key: string;
  value: string;
}

interface FrontmatterBlock {
  raw: string;
  entries: FrontmatterEntry[];
}

interface MarkdownSourceParts {
  frontmatter?: FrontmatterBlock;
  markdown: string;
}

interface OpenLinkMessage {
  type: 'openLink';
  href: string;
  openInNewTab?: boolean;
}

interface OpenSourceMessage {
  type: 'openSource';
}

interface HistoryMessage {
  type: 'back' | 'forward';
}

type WebviewMessage = OpenLinkMessage | OpenSourceMessage | HistoryMessage;
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
  private readonly onDidChangeCurrentMarkdownEmitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  public readonly onDidChangeCurrentMarkdown = this.onDidChangeCurrentMarkdownEmitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onCurrentMarkdownChanged?: (uri: vscode.Uri | undefined) => void
  ) {}

  public async open(uri: vscode.Uri): Promise<void> {
    await this.navigate(markdownLocationFromUri(uri), true);
  }

  public async back(): Promise<void> {
    await this.goBack();
  }

  public async forward(): Promise<void> {
    await this.goForward();
  }

  public getCurrentMarkdownUri(): vscode.Uri | undefined {
    return this.current?.uri;
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
    this.onDidChangeCurrentMarkdownEmitter.dispose();
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
          this.onDidChangeCurrentMarkdownEmitter.fire(undefined);
          this.onCurrentMarkdownChanged?.(undefined);
          void this.updateNavigationContext();
        }),
        this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
          void this.handleMessage(message);
        })
      );
    }

    this.current = location;
    this.onDidChangeCurrentMarkdownEmitter.fire(location.uri);
    this.onCurrentMarkdownChanged?.(location.uri);

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

    if (message.type === 'openSource') {
      if (this.current) {
        await openMarkdownSource(this.current.uri);
      }

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
    return renderMarkdownHtml(location, this.panel!.webview);
  }
}

class MarkdownBrowserCustomDocument implements vscode.CustomDocument {
  public constructor(public readonly uri: vscode.Uri) {}

  public dispose(): void {
    // The preview reads directly from disk, so there is no document model to release.
  }
}

class MarkdownBrowserCustomEditorProvider implements vscode.CustomReadonlyEditorProvider<MarkdownBrowserCustomDocument> {
  private readonly panelUrisByDocumentUri = new Map<string, Map<vscode.WebviewPanel, vscode.Uri>>();
  private readonly onDidChangeCurrentMarkdownEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChangeCurrentMarkdown = this.onDidChangeCurrentMarkdownEmitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onCurrentMarkdownChanged?: (uri: vscode.Uri) => void
  ) {}

  public openCustomDocument(uri: vscode.Uri): MarkdownBrowserCustomDocument {
    return new MarkdownBrowserCustomDocument(uri);
  }

  public async resolveCustomEditor(
    document: MarkdownBrowserCustomDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const disposables: vscode.Disposable[] = [];
    const uriKey = documentUriKey(document.uri);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: getWebviewResourceRoots(this.context, document.uri)
    };

    const panelUris = this.panelUrisByDocumentUri.get(uriKey) ?? new Map<vscode.WebviewPanel, vscode.Uri>();
    panelUris.set(webviewPanel, document.uri);
    this.panelUrisByDocumentUri.set(uriKey, panelUris);

    disposables.push(
      webviewPanel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void this.handleMessage(document.uri, message);
      }),
      webviewPanel.onDidDispose(() => {
        disposables.splice(0).forEach((disposable) => disposable.dispose());
        const panelUris = this.panelUrisByDocumentUri.get(uriKey);
        panelUris?.delete(webviewPanel);

        if (!panelUris?.size) {
          this.panelUrisByDocumentUri.delete(uriKey);
        }
      })
    );

    await this.renderPanel(document.uri, webviewPanel);
    this.onDidChangeCurrentMarkdownEmitter.fire(document.uri.with({ fragment: '' }));
    this.onCurrentMarkdownChanged?.(document.uri.with({ fragment: '' }));
  }

  public async refresh(uri: vscode.Uri): Promise<void> {
    const panelUris = this.panelUrisByDocumentUri.get(documentUriKey(uri));

    if (!panelUris?.size) {
      return;
    }

    await Promise.all([...panelUris].map(([panel, panelUri]) => this.renderPanel(panelUri, panel)));
  }

  private async renderPanel(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel): Promise<void> {
    webviewPanel.title = path.basename(uri.fsPath);
    webviewPanel.webview.html = await renderMarkdownHtml({ uri, fragment: uri.fragment || undefined }, webviewPanel.webview);
  }

  private async handleMessage(sourceUri: vscode.Uri, message: WebviewMessage): Promise<void> {
    if (message.type === 'openSource') {
      await openMarkdownSource(sourceUri);
      return;
    }

    if (message.type !== 'openLink') {
      return;
    }

    const target = await resolveMarkdownLink(sourceUri, message.href);

    if (target.kind === 'markdown') {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        target.location.uri.with({ fragment: target.location.fragment }),
        MARKDOWN_PREVIEW_EDITOR,
        {
          preview: message.openInNewTab !== true,
          viewColumn: vscode.ViewColumn.Active
        }
      );
      return;
    }

    await openLinkTargetInNewTab(target);
  }
}

async function renderMarkdownHtml(location: MarkdownLocation, webview: vscode.Webview): Promise<string> {
  const [source, stat] = await Promise.all([
    readUtf8File(location.uri),
    statUri(location.uri)
  ]);
  const sourceParts = splitFrontmatter(source);
  const rendered = await renderMarkdown(sourceParts.markdown);
  const fileDates = renderFileDates(stat);
  const frontmatter = renderFrontmatter(sourceParts.frontmatter);
  const body = rewriteLocalImageSources(rendered, location.uri, webview);
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
    .file-dates {
      margin: 0 0 18px;
      color: var(--vscode-descriptionForeground);
      font-size: 0.86em;
      line-height: 1.4;
    }
    .file-dates time {
      white-space: nowrap;
    }
    .frontmatter {
      margin: 0 0 24px;
      padding: 12px 14px;
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
    }
    .frontmatter dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: 8px 16px;
      margin: 0;
    }
    .frontmatter-row { display: contents; }
    .frontmatter dt {
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
    }
    .frontmatter dd {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .frontmatter pre {
      margin: 0;
      padding: 0;
      background: transparent;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <main class="markdown-body">
${fileDates}
${frontmatter}
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

    document.addEventListener('dblclick', (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (target?.closest('a, button, input, textarea, select, summary, [contenteditable="true"]')) {
        return;
      }

      event.preventDefault();
      vscode.postMessage({ type: 'openSource' });
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
  private readonly directoryChildrenCache = new Map<string, Promise<MarkdownNode[]>>();
  private readonly containsMarkdownCache = new Map<string, Promise<boolean>>();
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
    this.directoryChildrenCache.clear();
    this.containsMarkdownCache.clear();
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

  public async hasGitWorkspace(): Promise<boolean> {
    const { hasGitWorkspace } = await this.getGitState();
    return hasGitWorkspace;
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

  private getDirectoryChildren(
    uri: vscode.Uri,
    workspaceFolder?: vscode.WorkspaceFolder
  ): Promise<MarkdownNode[]> {
    const cacheKey = directoryCacheKey(uri, workspaceFolder);
    const cached = this.directoryChildrenCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const children = this.getDirectoryChildrenUncached(uri, workspaceFolder);
    this.directoryChildrenCache.set(cacheKey, children);
    return children;
  }

  private async getDirectoryChildrenUncached(
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
          isFileType(fileType)
          && isMarkdownFile(name)
          && await this.isVisibleMarkdownFile(childUri, workspaceFolder)
        ) {
          nodes.push(new MarkdownNode(childUri, 'file', workspaceFolder));
          return;
        }

        if (
          isDirectoryType(fileType)
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

  private containsMarkdown(
    uri: vscode.Uri,
    workspaceFolder?: vscode.WorkspaceFolder
  ): Promise<boolean> {
    const cacheKey = directoryCacheKey(uri, workspaceFolder);
    const cached = this.containsMarkdownCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const containsMarkdown = this.containsMarkdownUncached(uri, workspaceFolder);
    this.containsMarkdownCache.set(cacheKey, containsMarkdown);
    return containsMarkdown;
  }

  private async containsMarkdownUncached(
    uri: vscode.Uri,
    workspaceFolder?: vscode.WorkspaceFolder
  ): Promise<boolean> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);

      for (const [name, fileType] of entries) {
        const childUri = vscode.Uri.joinPath(uri, name);

        if (
          isFileType(fileType)
          && isMarkdownFile(name)
          && await this.isVisibleMarkdownFile(childUri, workspaceFolder)
        ) {
          return true;
        }

        if (
          isDirectoryType(fileType)
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

class LinkedMarkdownNode extends vscode.TreeItem {
  public constructor(
    public readonly kind: LinkedMarkdownNodeKind,
    public readonly uri: vscode.Uri,
    label: string,
    description?: string,
    commandUri: vscode.Uri = uri
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    this.id = `${kind}:${commandUri.toString()}`;
    this.contextValue = `markdownBrowser.linked.${kind}`;
    this.description = description;

    if (kind === 'file') {
      this.resourceUri = uri.with({ fragment: '' });
      this.command = {
        command: 'markdownBrowser.openPreview',
        title: 'Open Markdown Preview',
        arguments: [commandUri]
      };
    } else {
      this.iconPath = new vscode.ThemeIcon('info');
    }
  }
}

class LinkedMarkdownProvider implements vscode.TreeDataProvider<LinkedMarkdownNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<LinkedMarkdownNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private currentMarkdownUri?: vscode.Uri;
  private linkedMarkdownFilesCache?: Promise<LinkedMarkdownNode[]>;
  private gitState?: Promise<GitWorkspaceState>;

  public constructor(private showGitignoredFiles: boolean) {}

  public setCurrentMarkdownUri(uri: vscode.Uri | undefined): void {
    const markdownUri = uri && isMarkdownFile(uri.fsPath) ? uri.with({ fragment: '' }) : undefined;

    if (sameOptionalUri(this.currentMarkdownUri, markdownUri)) {
      return;
    }

    this.currentMarkdownUri = markdownUri;
    this.refresh();
  }

  public setShowGitignoredFiles(showGitignoredFiles: boolean): void {
    this.showGitignoredFiles = showGitignoredFiles;
    this.refresh();
  }

  public getCurrentMarkdownUri(): vscode.Uri | undefined {
    return this.currentMarkdownUri;
  }

  public refresh(uri?: vscode.Uri): void {
    if (uri) {
      if (!this.currentMarkdownUri || !sameUri(uri.with({ fragment: '' }), this.currentMarkdownUri)) {
        return;
      }
    }

    this.linkedMarkdownFilesCache = undefined;
    this.gitState = undefined;
    this.onDidChangeTreeDataEmitter.fire();
  }

  public getTreeItem(element: LinkedMarkdownNode): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: LinkedMarkdownNode): Promise<LinkedMarkdownNode[]> {
    if (element) {
      return [];
    }

    this.linkedMarkdownFilesCache ??= this.getLinkedMarkdownChildrenUncached();
    return this.linkedMarkdownFilesCache;
  }

  private async getLinkedMarkdownChildrenUncached(): Promise<LinkedMarkdownNode[]> {
    if (!this.currentMarkdownUri) {
      return [createLinkedMessageNode('Open a Markdown file')];
    }

    let locations: MarkdownLocation[];
    try {
      locations = await getLinkedMarkdownLocations(this.currentMarkdownUri);
    } catch {
      return [createLinkedMessageNode('Could not read current file')];
    }

    if (!locations.length) {
      return [createLinkedMessageNode('No linked Markdown files')];
    }

    const nodes: LinkedMarkdownNode[] = [];

    for (const location of locations) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(location.uri);

      if (!await this.isVisibleMarkdownFile(location.uri, workspaceFolder)) {
        continue;
      }

      nodes.push(createLinkedFileNode(location, this.currentMarkdownUri, workspaceFolder));
    }

    return nodes.length ? nodes : [createLinkedMessageNode('No linked Markdown files')];
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
  const linkedProvider = new LinkedMarkdownProvider(initialShowGitignoredFiles);
  const treeView = vscode.window.createTreeView('markdownBrowser.files', {
    treeDataProvider: provider
  });
  const linkedTreeView = vscode.window.createTreeView('markdownBrowser.linkedFiles', {
    treeDataProvider: linkedProvider
  });
  const debugOutput = vscode.window.createOutputChannel('Markdown Browser');
  const updateLinkedMarkdownUri = (uri: vscode.Uri | undefined) => {
    linkedProvider.setCurrentMarkdownUri(uri);
    linkedTreeView.description = uri ? path.basename(uri.fsPath) : undefined;
  };
  const markdownPreview = new MarkdownBrowserPreview(context, updateLinkedMarkdownUri);
  const markdownPreviewEditor = new MarkdownBrowserCustomEditorProvider(context, updateLinkedMarkdownUri);
  let treeExpanded = false;
  let treeBusy = false;
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.viewMode', initialViewMode);
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
  void vscode.commands.executeCommand('setContext', TREE_BUSY_CONTEXT, treeBusy);
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.showGitignoredFiles', initialShowGitignoredFiles);
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.previewCanGoBack', false);
  void vscode.commands.executeCommand('setContext', 'markdownBrowser.previewCanGoForward', false);
  void updateHasGitWorkspaceContext(provider);

  const runExclusiveTreeOperation = async (operation: () => Promise<void>): Promise<void> => {
    if (treeBusy) {
      return;
    }

    treeBusy = true;
    await vscode.commands.executeCommand('setContext', TREE_BUSY_CONTEXT, treeBusy);

    try {
      await operation();
    } finally {
      treeBusy = false;
      await vscode.commands.executeCommand('setContext', TREE_BUSY_CONTEXT, treeBusy);
    }
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{md,markdown,mdown,mkd,mkdn}');
  const refresh = () => {
    treeExpanded = false;
    void vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
    provider.refresh();
    linkedProvider.refresh();
    void updateHasGitWorkspaceContext(provider);
  };
  const refreshChangedMarkdown = (uri: vscode.Uri) => {
    void markdownPreview.refreshIfCurrent(uri);
    void markdownPreviewEditor.refresh(uri);
    linkedProvider.refresh(uri);
  };
  const updateCurrentMarkdownFromActiveTab = () => {
    const uri = getCurrentMarkdownUri(markdownPreview);

    if (uri) {
      updateLinkedMarkdownUri(uri);
    }
  };
  updateCurrentMarkdownFromActiveTab();

  context.subscriptions.push(
    treeView,
    linkedTreeView,
    debugOutput,
    markdownPreview,
    markdownPreview.onDidChangeCurrentMarkdown((uri) => {
      updateLinkedMarkdownUri(uri ?? getCurrentMarkdownUri(markdownPreview));
    }),
    markdownPreviewEditor.onDidChangeCurrentMarkdown((uri) => updateLinkedMarkdownUri(uri)),
    vscode.window.registerCustomEditorProvider(MARKDOWN_PREVIEW_EDITOR, markdownPreviewEditor),
    vscode.window.onDidChangeActiveTextEditor(updateCurrentMarkdownFromActiveTab),
    vscode.window.tabGroups.onDidChangeTabs(updateCurrentMarkdownFromActiveTab),
    vscode.window.tabGroups.onDidChangeTabGroups(updateCurrentMarkdownFromActiveTab),
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
    vscode.commands.registerCommand('markdownBrowser.refresh', () => {
      if (!treeBusy) {
        refresh();
      }
    }),
    vscode.commands.registerCommand('markdownBrowser.showDebugInfo', () => {
      debugOutput.clear();
      debugOutput.appendLine(formatDebugInfo(markdownPreview, linkedProvider));
      debugOutput.show(true);
    }),
    vscode.commands.registerCommand('markdownBrowser.expandAll', () => runExclusiveTreeOperation(async () => {
      await expandAll(treeView, provider);
      treeExpanded = true;
      await vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
    })),
    vscode.commands.registerCommand('markdownBrowser.collapseAll', () => runExclusiveTreeOperation(async () => {
      await vscode.commands.executeCommand(COLLAPSE_ALL_COMMAND);
      treeExpanded = false;
      await vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
    })),
    vscode.commands.registerCommand('markdownBrowser.openPreview', (uri?: vscode.Uri) => openMarkdownPreview(markdownPreview, uri)),
    vscode.commands.registerCommand('markdownBrowser.navigateBack', () => markdownPreview.back()),
    vscode.commands.registerCommand('markdownBrowser.navigateForward', () => markdownPreview.forward()),
    vscode.commands.registerCommand('markdownBrowser.showListView', () => runExclusiveTreeOperation(async () => {
      treeExpanded = false;
      await vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
      await updateViewMode(context, provider, 'list');
    })),
    vscode.commands.registerCommand('markdownBrowser.showTreeView', () => runExclusiveTreeOperation(async () => {
      treeExpanded = false;
      await vscode.commands.executeCommand('setContext', 'markdownBrowser.treeExpanded', treeExpanded);
      await updateViewMode(context, provider, 'tree');
    })),
    vscode.commands.registerCommand(
      'markdownBrowser.showGitignoredFiles',
      () => runExclusiveTreeOperation(() => updateGitignoredVisibility(context, provider, linkedProvider, true))
    ),
    vscode.commands.registerCommand(
      'markdownBrowser.hideGitignoredFiles',
      () => runExclusiveTreeOperation(() => updateGitignoredVisibility(context, provider, linkedProvider, false))
    ),
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

function getCurrentMarkdownUri(markdownPreview: MarkdownBrowserPreview): vscode.Uri | undefined {
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;

  if (activeTab) {
    const activeTabUri = getMarkdownUriFromTab(activeTab, markdownPreview);

    if (activeTabUri) {
      return activeTabUri;
    }
  }

  return getActiveMarkdownTextEditorUri()
    ?? getVisibleMarkdownTextEditorUri()
    ?? getOpenMarkdownTabUri(markdownPreview);
}

function getMarkdownUriFromTab(
  tab: vscode.Tab,
  markdownPreview: MarkdownBrowserPreview
): vscode.Uri | undefined {
  const input = tab.input;

  if (input instanceof vscode.TabInputText) {
    return isMarkdownFile(input.uri.fsPath) ? input.uri : undefined;
  }

  if (input instanceof vscode.TabInputCustom) {
    return input.viewType === MARKDOWN_PREVIEW_EDITOR && isMarkdownFile(input.uri.fsPath)
      ? input.uri
      : undefined;
  }

  if (input instanceof vscode.TabInputWebview) {
    return input.viewType === MARKDOWN_BROWSER_VIEW_TYPE
      ? markdownPreview.getCurrentMarkdownUri()
      : undefined;
  }

  return undefined;
}

function getActiveMarkdownTextEditorUri(): vscode.Uri | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri && isMarkdownFile(uri.fsPath) ? uri : undefined;
}

function getVisibleMarkdownTextEditorUri(): vscode.Uri | undefined {
  return vscode.window.visibleTextEditors.find((editor) => isMarkdownFile(editor.document.uri.fsPath))?.document.uri;
}

function getOpenMarkdownTabUri(markdownPreview: MarkdownBrowserPreview): vscode.Uri | undefined {
  const activeGroup = vscode.window.tabGroups.activeTabGroup;
  const groups = [
    activeGroup,
    ...vscode.window.tabGroups.all.filter((group) => group !== activeGroup)
  ];

  for (const group of groups) {
    for (const tab of group.tabs) {
      const uri = getMarkdownUriFromTab(tab, markdownPreview);

      if (uri) {
        return uri;
      }
    }
  }

  return undefined;
}

function formatDebugInfo(
  markdownPreview: MarkdownBrowserPreview,
  linkedProvider: LinkedMarkdownProvider
): string {
  const activeGroup = vscode.window.tabGroups.activeTabGroup;
  const activeTab = activeGroup.activeTab;
  const lines = [
    `time: ${new Date().toISOString()}`,
    `linkedProvider.currentMarkdownUri: ${formatUri(linkedProvider.getCurrentMarkdownUri())}`,
    `markdownPreview.currentMarkdownUri: ${formatUri(markdownPreview.getCurrentMarkdownUri())}`,
    `resolvedCurrentMarkdownUri: ${formatUri(getCurrentMarkdownUri(markdownPreview))}`,
    `activeTextEditor: ${formatUri(vscode.window.activeTextEditor?.document.uri)}`,
    `activeTabGroup: column=${activeGroup.viewColumn} active=${activeGroup.isActive}`,
    `activeTab: ${activeTab ? describeTab(activeTab, markdownPreview) : '<none>'}`,
    '',
    'visibleTextEditors:',
    ...vscode.window.visibleTextEditors.map((editor) => `- ${formatUri(editor.document.uri)}`),
    '',
    'tabGroups:',
    ...vscode.window.tabGroups.all.flatMap((group, groupIndex) => [
      `- group ${groupIndex} column=${group.viewColumn} active=${group.isActive}`,
      ...group.tabs.map((tab) => `  - ${describeTab(tab, markdownPreview)}`)
    ])
  ];

  return lines.join('\n');
}

function describeTab(tab: vscode.Tab, markdownPreview: MarkdownBrowserPreview): string {
  const active = tab.isActive ? 'active' : 'inactive';
  return `${tab.label} [${active}] input=${describeTabInput(tab.input)} markdownUri=${formatUri(getMarkdownUriFromTab(tab, markdownPreview))}`;
}

function describeTabInput(input: vscode.Tab['input']): string {
  if (input instanceof vscode.TabInputText) {
    return `text:${formatUri(input.uri)}`;
  }

  if (input instanceof vscode.TabInputCustom) {
    return `custom:${input.viewType}:${formatUri(input.uri)}`;
  }

  if (input instanceof vscode.TabInputWebview) {
    return `webview:${input.viewType}`;
  }

  if (input instanceof vscode.TabInputTextDiff) {
    return `textDiff:${formatUri(input.original)}..${formatUri(input.modified)}`;
  }

  if (input instanceof vscode.TabInputNotebook) {
    return `notebook:${input.notebookType}:${formatUri(input.uri)}`;
  }

  if (input instanceof vscode.TabInputNotebookDiff) {
    return `notebookDiff:${input.notebookType}:${formatUri(input.original)}..${formatUri(input.modified)}`;
  }

  if (input instanceof vscode.TabInputTerminal) {
    return 'terminal';
  }

  return `<unknown:${Object.prototype.toString.call(input)}>`;
}

function formatUri(uri: vscode.Uri | undefined): string {
  return uri?.toString() ?? '<none>';
}

function markdownLocationFromUri(uri: vscode.Uri): MarkdownLocation {
  return {
    uri: uri.with({ fragment: '' }),
    fragment: uri.fragment || undefined
  };
}

async function openMarkdownSource(uri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri.with({ fragment: '' }));
  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Active
  });
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
  linkedProvider: LinkedMarkdownProvider,
  showGitignoredFiles: boolean
): Promise<void> {
  await context.workspaceState.update(SHOW_GITIGNORED_STORAGE_KEY, showGitignoredFiles);
  await vscode.commands.executeCommand('setContext', 'markdownBrowser.showGitignoredFiles', showGitignoredFiles);
  provider.setShowGitignoredFiles(showGitignoredFiles);
  linkedProvider.setShowGitignoredFiles(showGitignoredFiles);
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

async function getLinkedMarkdownLocations(sourceUri: vscode.Uri): Promise<MarkdownLocation[]> {
  const documentUri = sourceUri.with({ fragment: '' });
  const source = await readUtf8File(documentUri);
  const sourceParts = splitFrontmatter(source);
  const rendered = await renderMarkdown(sourceParts.markdown);
  const hrefs = extractAnchorHrefs(rendered);
  const locations: MarkdownLocation[] = [];
  const seenDocuments = new Set<string>();

  for (const href of hrefs) {
    const target = await resolveMarkdownLink(documentUri, href);

    if (target.kind !== 'markdown' || sameUri(target.location.uri, documentUri)) {
      continue;
    }

    const key = documentUriKey(target.location.uri);

    if (seenDocuments.has(key)) {
      continue;
    }

    seenDocuments.add(key);
    locations.push(target.location);
  }

  return locations;
}

function extractAnchorHrefs(html: string): string[] {
  const hrefs: string[] = [];

  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = match[0];
    const href = getHtmlAttribute(tag, 'data-href') ?? getHtmlAttribute(tag, 'href');

    if (href) {
      hrefs.push(decodeHtmlAttributeValue(href));
    }
  }

  return hrefs;
}

function getHtmlAttribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function decodeHtmlAttributeValue(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|apos|lt|gt|quot);/gi, (entity, decimal, hex) => {
    if (decimal) {
      return String.fromCodePoint(Number(decimal));
    }

    if (hex) {
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }

    switch (entity.toLowerCase()) {
      case '&amp;':
        return '&';
      case '&apos;':
        return "'";
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      case '&quot;':
        return '"';
      default:
        return entity;
    }
  });
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

function renderFileDates(stat: vscode.FileStat | undefined): string {
  if (!stat || (stat.ctime <= 0 && stat.mtime <= 0)) {
    return '';
  }

  const created = stat.ctime > 0 ? new Date(stat.ctime) : undefined;
  const modified = stat.mtime > 0 ? new Date(stat.mtime) : undefined;

  if (created && modified && getLocalDateKey(created) !== getLocalDateKey(modified)) {
    return [
      '<p class="file-dates" aria-label="File dates">',
      `  Created <time datetime="${getLocalDateKey(created)}">${escapeHtml(formatFileDate(created))}</time>`,
      `  &middot; Modified <time datetime="${getLocalDateKey(modified)}">${escapeHtml(formatFileDate(modified))}</time>`,
      '</p>'
    ].join('\n');
  }

  const date = created ?? modified;

  if (!date) {
    return '';
  }

  const label = created && modified ? 'Created/modified' : created ? 'Created' : 'Modified';

  return [
    '<p class="file-dates" aria-label="File dates">',
    `  ${label} <time datetime="${getLocalDateKey(date)}">${escapeHtml(formatFileDate(date))}</time>`,
    '</p>'
  ].join('\n');
}

function formatFileDate(date: Date): string {
  return FILE_DATE_FORMATTER.format(date);
}

function getLocalDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function splitFrontmatter(source: string): MarkdownSourceParts {
  const openingFence = /^\uFEFF?---[ \t]*(?:\r?\n|$)/.exec(source);

  if (!openingFence || openingFence[0].endsWith('---')) {
    return { markdown: source };
  }

  const contentStart = openingFence[0].length;
  let cursor = contentStart;

  while (cursor < source.length) {
    const lineEnd = source.indexOf('\n', cursor);
    const nextCursor = lineEnd === -1 ? source.length : lineEnd + 1;
    const line = source.slice(cursor, lineEnd === -1 ? source.length : lineEnd).replace(/\r$/, '');

    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) {
      const raw = source.slice(contentStart, cursor);

      return {
        frontmatter: {
          raw,
          entries: parseFrontmatterEntries(raw)
        },
        markdown: source.slice(nextCursor)
      };
    }

    cursor = nextCursor;
  }

  return { markdown: source };
}

function parseFrontmatterEntries(raw: string): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  let current: { key: string; valueLines: string[] } | undefined;

  const flushCurrent = () => {
    if (!current) {
      return;
    }

    entries.push({
      key: current.key,
      value: current.valueLines.join('\n').replace(/^\n/, '').trimEnd()
    });
    current = undefined;
  };

  for (const line of raw.split(/\r?\n/)) {
    if (!current && (!line.trim() || line.trimStart().startsWith('#'))) {
      continue;
    }

    const keyValue = /^([^:\s][^:]*):(?:[ \t]*(.*))?$/.exec(line);

    if (keyValue) {
      flushCurrent();
      current = {
        key: keyValue[1].trim(),
        valueLines: [keyValue[2] ?? '']
      };
      continue;
    }

    if (current) {
      current.valueLines.push(line);
    }
  }

  flushCurrent();
  return entries;
}

function renderFrontmatter(frontmatter: FrontmatterBlock | undefined): string {
  if (!frontmatter || (!frontmatter.entries.length && !frontmatter.raw.trim())) {
    return '';
  }

  if (!frontmatter.entries.length) {
    return `<section class="frontmatter" aria-label="Frontmatter"><pre>${escapeHtml(frontmatter.raw.trim())}</pre></section>`;
  }

  const rows = frontmatter.entries.map((entry) => {
    return [
      '    <div class="frontmatter-row">',
      `      <dt>${escapeHtml(entry.key)}</dt>`,
      `      <dd>${escapeHtml(entry.value)}</dd>`,
      '    </div>'
    ].join('\n');
  });

  return [
    '<section class="frontmatter" aria-label="Frontmatter">',
    '  <dl>',
    ...rows,
    '  </dl>',
    '</section>'
  ].join('\n');
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

function sameOptionalUri(a: vscode.Uri | undefined, b: vscode.Uri | undefined): boolean {
  return (!a && !b) || (!!a && !!b && sameUri(a, b));
}

function documentUriKey(uri: vscode.Uri): string {
  return uri.with({ fragment: '' }).toString();
}

function directoryCacheKey(uri: vscode.Uri, workspaceFolder?: vscode.WorkspaceFolder): string {
  return `${workspaceFolder?.uri.toString() ?? ''}\0${uri.toString()}`;
}

function isFileType(fileType: vscode.FileType): boolean {
  return (fileType & vscode.FileType.File) === vscode.FileType.File;
}

function isDirectoryType(fileType: vscode.FileType): boolean {
  return (
    (fileType & vscode.FileType.Directory) === vscode.FileType.Directory
    && (fileType & vscode.FileType.SymbolicLink) !== vscode.FileType.SymbolicLink
  );
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

async function updateHasGitWorkspaceContext(provider: MarkdownBrowserProvider): Promise<void> {
  const hasGitWorkspace = await provider.hasGitWorkspace();
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

function createLinkedMessageNode(label: string): LinkedMarkdownNode {
  return new LinkedMarkdownNode('message', LINKED_FILES_MESSAGE_URI.with({ fragment: label }), label);
}

function createLinkedFileNode(
  location: MarkdownLocation,
  sourceUri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined
): LinkedMarkdownNode {
  const commandUri = location.fragment
    ? location.uri.with({ fragment: location.fragment })
    : location.uri;
  const descriptionParts = getLinkedFileDescriptionParts(location.uri, sourceUri, workspaceFolder);

  if (location.fragment) {
    descriptionParts.push(`#${decodeUriComponentSafe(location.fragment)}`);
  }

  const node = new LinkedMarkdownNode(
    'file',
    location.uri,
    path.basename(location.uri.fsPath),
    descriptionParts.join(' '),
    commandUri
  );

  node.tooltip = location.fragment
    ? `${location.uri.fsPath}#${decodeUriComponentSafe(location.fragment)}`
    : location.uri.fsPath;
  return node;
}

function getLinkedFileDescriptionParts(
  uri: vscode.Uri,
  sourceUri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined
): string[] {
  const descriptionParts: string[] = [];
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const relativeFilePath = workspaceFolder
    ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath)
    : path.relative(path.dirname(sourceUri.fsPath), uri.fsPath);
  const relativeDirectory = path.dirname(relativeFilePath);

  if (workspaceFolder && workspaceFolders.length > 1) {
    descriptionParts.push(workspaceFolder.name);
  }

  if (relativeDirectory !== '.') {
    descriptionParts.push(relativeDirectory);
  }

  return descriptionParts;
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
