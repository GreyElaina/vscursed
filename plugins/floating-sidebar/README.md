# VSCursed: Floating Side Bar

Lets the primary side bar float over the editor instead of pushing it aside, and pin it back into the layout,
like the two modes of Arc's or Chrome's vertical tabs. The pin at the right end of the side bar's title switches
between them, as does **Floating Side Bar: Pin or Float Primary Side Bar** (⌃⌘B on macOS, Ctrl+K B elsewhere).
The mode is kept for the profile, so every window follows it.

A floating side bar takes no room from the editor. It shows wherever the workbench would show it (⌘B, clicking
an activity bar icon, focusing a view), taking the focus when ⌘B shows it as the other two do, and hides again
when anything it covers is clicked or focused, after something dragged out of it is dropped, and on Escape,
giving the focus back to the editor. Escape goes to whatever else wants it first: a text field
in the side bar (renaming a file, the search box), a find widget, an editor's suggestions or selection; a list's
selection is not cleared, the side bar hides instead. While shown it continues the activity bar: in its colour,
without the divider between them, and with the view's name level with the icon that opened it.

Hovering the activity bar can show the floating primary side bar too; it then hides again once the pointer
leaves it, unless it was used meanwhile. This is off by default:

```jsonc
// settings.json
"vscursed.plugins": {
  "vscursed.floating-sidebar": { "hoverToReveal": true }
}
```

The secondary side bar can float the same way, with a pin and a command of its own:

```jsonc
// settings.json
"vscursed.plugins": {
  "vscursed.floating-sidebar": { "secondarySideBar": true }
}
```

The plugin works on workbench internals: it sets a floating side bar's grid constraints to zero width, lays the
part out at its pinned width itself, and keeps the workbench persisting the pinned width.
