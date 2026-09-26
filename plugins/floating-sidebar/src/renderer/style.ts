import type { SideId } from '../protocol.ts'

/** Marks the grid slot of a floating side bar, which the side bar overhangs. */
export const slotClass = (id: SideId) => `vscursed-floating-${id}-slot`
export const rightClass = 'vscursed-floating-right'
export const widthVariable = (id: SideId) => `--vscursed-floating-${id}-width`
export const titleVariable = (id: SideId) => `--vscursed-floating-${id}-title`
export const dragOutClass = (id: SideId) => `vscursed-floating-${id}-dragout`
/** Set on the workbench while the floating side bar is shown. */
export const openClass = (id: SideId) => `vscursed-floating-${id}-open`
export const pinClass = 'vscursed-floating-pin'

/**
 * A shown floating side bar lies flush against the edge it is docked to and as tall as its grid row, with a
 * title row as tall as the first activity bar item beside it, so the view's name lines up with its icon.
 * Only the edge facing the editor keeps its border, and a shadow on that side lifts it above the editor.
 * The zero-width grid slot stays in the grid's stacking context, above the editor.
 */
function sideStyle(id: SideId) {
  const slot = `.monaco-workbench .${slotClass(id)}`
  const title = `var(${titleVariable(id)})`
  return `
${slot} {
  z-index: 40;
  overflow: visible;
}
${slot} > .part {
  position: absolute;
  top: 0;
  left: 0;
  width: var(${widthVariable(id)}) !important;
  height: 100% !important;
  box-shadow: 4px 0 10px -2px var(--vscode-widget-shadow);
  clip-path: inset(0 -16px 0 0);
}
${slot}.${rightClass} > .part {
  left: auto;
  right: 0;
  box-shadow: -4px 0 10px -2px var(--vscode-widget-shadow);
  clip-path: inset(0 0 0 -16px);
}
${slot} > .part > .title {
  height: ${title} !important;
}
${slot} > .part > .title > .title-label,
${slot} > .part > .title > .title-label h2 {
  height: ${title};
  line-height: ${title};
}
${slot} > .part > .title > .title-actions {
  margin-top: calc((${title} - 35px) / 2);
}
.monaco-workbench.${dragOutClass(id)} .${slotClass(id)} {
  visibility: hidden;
  pointer-events: none;
}
`
}

/**
 * The activity bar sits beside the primary side bar only, so only that side bar merges with it: painted in
 * its colour (outside the Modern UI, which draws the side bar as a card of its own) and without the divider.
 */
const besideActivityBar = `
.monaco-workbench:not(.floating-panels) .${slotClass('primary')} > .part {
  --vscode-sideBar-background: var(--vscode-activityBar-background);
  --vscode-sideBarTitle-background: var(--vscode-activityBar-background);
  --vscode-sideBarStickyScroll-background: var(--vscode-activityBar-background);
  background-color: var(--vscode-activityBar-background) !important;
}
.monaco-workbench:not(.floating-panels) .${slotClass('primary')} > .part > .title {
  background-color: var(--vscode-activityBar-background);
}
.monaco-workbench.${openClass('primary')} > .monaco-grid-view .part.activitybar.bordered::before {
  display: none;
}
`

export function style(ids: SideId[]) {
  return `${ids.map(sideStyle).join('')}${besideActivityBar}
.monaco-workbench .part > .title > .${pinClass} {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin: auto 2px auto 0;
  border-radius: 5px;
  color: inherit;
  cursor: pointer;
}
.monaco-workbench .part > .title > .${pinClass}:hover {
  background-color: var(--vscode-toolbar-hoverBackground);
}
.monaco-workbench .part > .title > .${pinClass}:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
`
}
