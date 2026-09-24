# VSCursed Sample: Command Log

A renderer plugin that wraps `ICommandService.executeCommand`, the same method that
_VSCursed Sample: Realms_ wraps, and shows how many commands ran. Either plugin can be loaded,
reconfigured, replaced or unloaded without disturbing the other's layer.

```jsonc
// settings.json
"vscursed.plugins": {
  "vscursed.sample-command-log": { "ignore": ["workbench.action.quickOpen"] }
}
```
