# VSCursed: Supermaven

Supermaven completions as a native inline completion provider, in three realms:

- **shared process**: runs one `sm-agent` per workspace and provides the `supermaven` channel. Without
  `binaryPath` it downloads the agent through VS Code's request service (so proxy settings apply),
  checks the SHA-256 that Supermaven publishes, and keeps it in the default profile's global storage
  under `vscursed.supermaven/sm-agent/<version>/`. Connection and account changes are bridge events.
- **extension host**: owns commands, localization and the status bar through the extension's `vscode`
  API. Renderer presentation and shared-process agent state arrive over typed bridge channels.
- **renderer**: registers the provider for every language and takes the place of the other inline
  completion providers. It keeps one answer per document and hands it out line by line while the text
  typed since still matches it; a slow answer never replaces a newer one. Editor hints receive their
  localized labels from the extension host.

Accepting a line fetches the rest of the answer and shows the next line. A line that starts below a
blank line cannot be ghost text; it is marked with ⏎ and inserted with ⌥⇥ (`Supermaven: Accept Next Line`, a
contributed keybinding that holds while the `vscursed.supermaven.lineReady` context key is set, so it can
be rebound in the Keyboard Shortcuts editor). Answers that skip or delete
lines appear as `↓ n` / `⌦ n` markers, and accepting one moves the caret or deletes the lines it names,
if they are still there.

In `subtle` mode answers are fetched quietly and shown while ⌥ is held; ⌥⇥ accepts. The status bar
entry shows the agent's connection and account; clicking it (`Supermaven: Show Status`) opens details and a
restart action (`Supermaven: Restart Sidecar`). These labels follow the active VS Code display language.

```jsonc
// settings.json
"vscursed.plugins": {
  "vscursed.supermaven": { "mode": "subtle" }
}
```

## Development

`pnpm test` covers answer decoding and deterministic sm-agent token stream handling.
