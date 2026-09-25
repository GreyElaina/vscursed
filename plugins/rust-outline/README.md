# VSCursed: Rust Outline

Reshapes the Outline view of Rust documents around types instead of `impl` blocks:

- `impl Widget` members appear directly under `Widget` (or in an `impl` node with `inherentMode: "group"`).
- `impl fmt::Display for Widget` becomes a `Display` node under `Widget`, ordered by trait name or position.
- Impls of boilerplate traits (`Debug`, `Clone`, `PartialEq`, …) fold into `Boilerplate (n)` when a type has several.
- Impls of types not declared in the document collect in `Other impls (n)`, or stay at the root.
- Symbols inside function bodies are hidden, and function details shrink to `(self, a, b) -> R`.

Breadcrumbs, Go to Symbol and other languages keep the native outline. Selecting, previewing, the cursor
following and problem markers work as in the native Outline.
Synthetic group labels follow the active VS Code display language.

```jsonc
// settings.json
"vscursed.plugins": {
  "vscursed.rust-outline": {
    "groupImpls": true, // false keeps impl blocks where they are
    "inherentMode": "inline", // or "group"
    "traitImplOrder": "name", // or "position"
    "groupBoilerplate": true,
    "boilerplateTraits": ["Debug", "Clone", "PartialEq", "Eq", "Hash"],
    "orphans": "group", // or "keep"
    "bodyItems": "hide", // or "show"
    "detail": "params" // "full", "params", "return" or "none"
  }
}
```
