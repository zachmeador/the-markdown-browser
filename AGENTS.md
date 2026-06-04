# AGENTS.md

## Project Notes

- This is a VS Code extension named The Markdown Browser.
- Main source lives in `src/extension.ts`.
- The compiled extension entrypoint is `dist/extension.js`, as configured by `package.json` `main`.
- Extension manifest, commands, views, and Marketplace metadata live in `package.json`.
- Marketplace extension id: `ZachMeador.the-markdown-browser`.
- Keep changes small and avoid unrelated refactors.
- Do not overwrite user edits or unrelated dirty working tree changes.

## Development

- Install dependencies with `npm install`.
- Compile TypeScript with `npm run compile`.
- Use `npm run watch` for iterative TypeScript work.
- Manually test extension behavior from VS Code with an Extension Development Host (`F5`).

## Release Checklist

Use one release commit and an annotated `vX.Y.Z` git tag that points at that commit.

1. Choose the next semver version above the currently deployed Marketplace version.
2. Update `CHANGELOG.md` for the release. Create it if it does not exist. Use a section like `## X.Y.Z - YYYY-MM-DD`.
3. Update `package.json` and `package-lock.json` with `npm version X.Y.Z --no-git-tag-version`.
4. Run `npm run compile`.
5. Package and inspect the VSIX with `npx @vscode/vsce package`.
6. Stage the release files. Usually this is `package.json`, `package-lock.json`, and `CHANGELOG.md`; include `dist/` only if compiled output is intentionally tracked for the release.
7. Commit with `git commit -m "Release vX.Y.Z"`.
8. Tag the release commit with `git tag -a vX.Y.Z -m "vX.Y.Z"`.
9. Push the release commit and tag with `git push origin HEAD --follow-tags`.
10. Publish from the tagged commit with `npx @vscode/vsce publish`. If tag-based CI publishing is enabled, do not also publish locally.

## Publishing Notes

- Authenticate as the configured publisher with `npx @vscode/vsce login ZachMeador`, or set `VSCE_PAT` in the environment before publishing.
- `vsce publish patch`, `vsce publish minor`, `vsce publish major`, and `vsce publish X.Y.Z` can bump the version and create a git commit/tag automatically. Avoid that shortcut for normal releases here unless the changelog has already been handled, because the release commit should include the changelog update.
- For an automated proper release, add CI that runs only for pushed `v*` tags, installs dependencies, runs `npm run compile`, and publishes with `npx @vscode/vsce publish` using `VSCE_PAT` from CI secrets.
- Avoid checking in generated `.vsix` files unless the release process intentionally changes; they are currently ignored.

## References

- VS Code publishing docs: https://code.visualstudio.com/api/working-with-extensions/publishing-extension
- VS Code CI publishing docs: https://code.visualstudio.com/api/working-with-extensions/continuous-integration
