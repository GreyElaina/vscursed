import type { IKeyboardEvent } from 'vscode-internal/vs/base/browser/keyboardEvent.js'
import type { IContextKeyServiceTarget } from 'vscode-internal/vs/platform/contextkey/common/contextkey.js'
import type { IKeybindingService } from 'vscode-internal/vs/platform/keybinding/common/keybinding.js'
import type { IWorkbenchLayoutService } from 'vscode-internal/vs/workbench/services/layout/browser/layoutService.js'

/** A part as the workbench grid sees it (`Part` in `workbench/browser/part.ts`). */
export interface PartView {
  readonly element: HTMLElement
  /** Plain instance fields on side bar parts, which the grid reads on every relayout. */
  minimumWidth: number
  maximumWidth: number
  layout(width: number, height: number, top: number, left: number): void
  /** Firing it makes the grid read the constraints again. */
  readonly _onDidChange: { fire(event: undefined): void }
}

interface Size {
  width: number
  height: number
}

/** The private members of `Layout` (`workbench/browser/layout.ts`) this plugin relies on. */
export interface LayoutInternals extends IWorkbenchLayoutService {
  readonly activityBarPartView: PartView
  readonly sideBarPartView: PartView
  readonly auxiliaryBarPartView: PartView
  readonly editorPartView: object
  readonly workbenchGrid: {
    readonly element: HTMLElement
    getViewSize(view: object): Size
    getViewCachedVisibleSize(view: object): number | undefined
    resizeView(view: object, size: Size): void
  }
  readonly stateModel: {
    getInitializationValue(key: { name: string }): unknown
    setInitializationValue(key: { name: string }, value: unknown): void
  }
  /** Called whenever a side bar with an open view container is hidden. */
  focusPanelOrEditor(): void
}

/** The protected member of `AbstractKeybindingService` that every window's key presses go through. */
export interface KeybindingInternals extends IKeybindingService {
  /** Runs the command bound to the key press, if any; the key press is prevented if this returns true. */
  _dispatch(event: IKeyboardEvent, target: IContextKeyServiceTarget): boolean
}
