# The Markdown Browser

A minimal VS Code extension that adds a Markdown-focused workspace browser.

## What it does

- Adds a left-side activity bar container named **Markdown**.
- Shows workspace folders and only directories that contain Markdown files.
- Switches between tree mode and a flattened list mode from the Markdown view title bar.
- Toggles between expanding and collapsing the Markdown tree.
- Hides gitignored Markdown files by default when the workspace is inside a Git repo, with a view action to show them.
- Opens selected Markdown files directly in the built-in Markdown preview.
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

VS Code's built-in Markdown preview updates itself when preview links stay in-preview, so those clicks may not enter VS Code's normal editor history. VS Code extension keybindings support keyboard keys, not raw mouse side buttons, so mouse back/forward support needs either VS Code's own navigation stack or a custom preview webview owned by this extension.
