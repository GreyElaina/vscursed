# VSCursed: Reveal at Top

Wherever the editor would reveal a range "near the top if outside the viewport" (going to a definition,
picking a symbol in the Outline or in Go to Symbol), it reveals the range at the top of the viewport instead,
whether or not the range was already visible.

The plugin wraps `revealRangeNearTopIfOutsideViewport` on the code editor prototype, which it reaches through
the first editor the code editor service knows about. It has no settings:

```jsonc
// settings.json
"vscursed.plugins": {
  "vscursed.reveal-at-top": {}
}
```
