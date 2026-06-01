# The Markdown Browser

A minimal VS Code extension that adds a Markdown-focused workspace browser.

I wanted a more Obsidian-like behavior going through markdowns, so that's what this is.

Source: https://github.com/zachmeador/the-markdown-browser

Marketplace: https://marketplace.visualstudio.com/items?itemName=ZachMeador.the-markdown-browser

## What it does

- Adds a left-side activity bar container named **Markdown**.
- Shows workspace folders and only directories that contain Markdown files.
- Switches between tree mode and a flattened list mode from the Markdown view title bar.
- Toggles between expanding and collapsing the Markdown tree.
- Hides gitignored Markdown files by default when the workspace is inside a Git repo, with a view action to show them.
- Opens selected Markdown files in an extension-owned Markdown browser webview.
- Keeps Markdown links in the same browser tab and supports back/forward mouse buttons inside that webview.
- Adds Markdown Browser back/forward commands for the custom webview history.
- Adds a current-file/explorer command for opening Markdown files in preview.
- Adds a toggle command that makes VS Code's normal Explorer open `.md` files with the Markdown preview by default in the current workspace.
- Defaults Markdown preview links to open inside the preview, so local document links feel browser-like.
- Leaves VS Code's editor mouse back/forward navigation enabled for browser-style history movement.

## Development

```sh
npm install
npm run compile
```

Then press `F5` in VS Code to launch an Extension Development Host.

## Notes

The Markdown browser uses VS Code's Markdown renderer for document HTML, then wraps it in this extension's own webview shell. That makes local Markdown links stay in one tab and lets the webview handle mouse button 3/4 for browser-style back/forward navigation. VS Code's default global back/forward buttons use the workbench editor history, which is separate from this webview's internal Markdown-link history.
