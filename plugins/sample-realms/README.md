# VSCursed Sample: Realms

A Cordis plugin with a module in each VSCursed realm:

- **shared process**: provides the `sample.clock` channel, ticking every `interval` milliseconds.
- **main**: provides `sample.main`, describing the application from `IProductService`.
- **extension host**: provides `sample.extensionHost`, describing the host process.
- **renderer**: shows `label` and the clock in the status bar. Clicking it runs
  `sample-realms.describe`, which the plugin handles as a layer around `ICommandService` by asking
  the other three realms.

```jsonc
// settings.json
"vscursed.plugins": {
  "vscursed.sample-realms": { "label": "Clock", "interval": 500 }
}
```
