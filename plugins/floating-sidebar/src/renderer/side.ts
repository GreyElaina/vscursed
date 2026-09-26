import type { Context } from 'cordis'
import { ViewContainerLocation } from 'vscode-internal/vs/workbench/common/views.js'
import { Parts } from 'vscode-internal/vs/workbench/services/layout/browser/layoutService.js'
import type { ILifecycleService } from 'vscode-internal/vs/workbench/services/lifecycle/common/lifecycle.js'
import type { SideId } from '../protocol.ts'
import type { LayoutInternals, PartView } from './internals.ts'
import { rightClass, slotClass, titleVariable } from './style.ts'

export interface SideSpec {
  /** Names the classes, CSS variables, storage key and command of the side. */
  readonly id: SideId
  readonly part: Parts.SIDEBAR_PART | Parts.AUXILIARYBAR_PART
  readonly view: 'sideBarPartView' | 'auxiliaryBarPartView'
  /** The layout state key under which the workbench persists the width of the part. */
  readonly sizeKey: string
  /** The side bar across the editor, whose width growing this one must not take. */
  readonly other: 'sideBarPartView' | 'auxiliaryBarPartView'
  readonly otherPart: Parts.SIDEBAR_PART | Parts.AUXILIARYBAR_PART
  /** Where the views shown in the part live. */
  readonly location: ViewContainerLocation.Sidebar | ViewContainerLocation.AuxiliaryBar
  /** The workbench command that shows and hides the part (⌘B for the primary side bar). */
  readonly toggleCommand: string
}

export const primary: SideSpec = {
  id: 'primary',
  part: Parts.SIDEBAR_PART,
  view: 'sideBarPartView',
  sizeKey: 'sideBar.size',
  other: 'auxiliaryBarPartView',
  otherPart: Parts.AUXILIARYBAR_PART,
  location: ViewContainerLocation.Sidebar,
  toggleCommand: 'workbench.action.toggleSidebarVisibility',
}

export const secondary: SideSpec = {
  id: 'secondary',
  part: Parts.AUXILIARYBAR_PART,
  view: 'auxiliaryBarPartView',
  sizeKey: 'auxiliaryBar.size',
  other: 'sideBarPartView',
  otherPart: Parts.SIDEBAR_PART,
  location: ViewContainerLocation.AuxiliaryBar,
  toggleCommand: 'workbench.action.toggleAuxiliaryBar',
}

const defaultWidth = 300

/**
 * One side bar that either sits in the workbench grid as usual (pinned) or floats. A floating side bar keeps
 * its grid slot at zero width, so the grid never gives it room taken from the editor, and it is laid out at
 * its pinned width over the editor, continuing the activity bar next to it. Showing and hiding stay the
 * workbench's own, so every command and click that toggles the side bar keeps working.
 */
export class FloatingSide {
  floating = false
  /** The width of the pinned side bar, which the floating card keeps. */
  private width = defaultWidth
  private readonly view: PartView
  private readonly minimumWidth: number
  private readonly maximumWidth: number
  private suppressFocus = false

  constructor(
    ctx: Context,
    private readonly layout: LayoutInternals,
    lifecycle: ILifecycleService,
    readonly spec: SideSpec,
    private readonly onDidChange: () => void,
  ) {
    this.view = layout[spec.view]
    this.minimumWidth = this.view.minimumWidth
    this.maximumWidth = this.view.maximumWidth
    const side = this

    ctx.interceptor.around(this.view, 'layout', function (next, width, height, top, left) {
      if (!side.floating) return next(width, height, top, left)
      const right = side.anchoredRight
      this.element.parentElement?.classList.add(slotClass(spec.id))
      this.element.parentElement?.classList.toggle(rightClass, right)
      // The title row is laid out by CSS, the rest of the part from the height given here.
      const title = side.titleHeight()
      this.element.style.setProperty(titleVariable(spec.id), `${title}px`)
      return next(side.width, height - (title - side.defaultTitleHeight), top, right ? left - side.width : left)
    })

    // A floating slot is zero wide; the workbench must keep persisting the width the side bar is pinned at.
    ctx.interceptor.around(layout.stateModel, 'setInitializationValue', function (next, key, value) {
      const substitute = key.name === spec.sizeKey && side.floating
      return next(key, substitute ? side.width : value)
    })

    ctx.interceptor.around(layout, 'focusPanelOrEditor', function (next) {
      if (!side.suppressFocus) next()
    })

    // The grid lays a view out only when its bounds change, and a floating slot is always zero wide.
    ctx.effect(() => {
      const listener = layout.onDidChangePartVisibility(({ partId, visible }) => {
        if (partId === spec.part && visible && this.floating) this.relayout()
      })
      return () => listener.dispose()
    }, `floating-sidebar: ${spec.id} layout on show`)

    // The next window restores the layout saved on shutdown before this plugin loads, and a side bar saved as
    // shown would push the editor aside until then. Hiding it first makes the workbench save it hidden, at its
    // pinned width; shutdown events come before the layout is saved, and before plugins unload.
    ctx.effect(() => {
      const listener = lifecycle.onBeforeShutdown(() => {
        if (!this.floating) return
        if (this.visible) this.collapse()
        setCachedWidth(layout.workbenchGrid, this.view, this.width)
      })
      return () => listener.dispose()
    }, `floating-sidebar: ${spec.id} shutdown`)

    ctx.effect(() => () => this.pin(false), `floating-sidebar: ${spec.id} pin on unload`)
  }

  get visible() {
    return this.layout.isVisible(this.spec.part)
  }

  get element() {
    return this.view.element
  }

  /** The shown floating side bar; it overhangs its zero-width grid slot. */
  get region() {
    return this.floating && this.visible ? this.view.element : null
  }

  get floatingWidth() {
    return this.width
  }

  /** Floating side bars open towards the editor, away from the window edge they are docked to. */
  get anchoredRight() {
    return this.view.element.classList.contains('right')
  }

  private get defaultTitleHeight() {
    return this.layout.isFloatingPanelsEnabled() ? 32 : 35
  }

  /**
   * The title row of a floating side bar spans the first activity bar item next to it, so the view's name
   * lines up with the icon that opened it; without an activity bar alongside, it keeps its own height.
   */
  private titleHeight() {
    const bar = this.layout.activityBarPartView.element
    const item = bar.querySelector('.action-item')?.getBoundingClientRect()
    const beside = bar.classList.contains('right') === this.anchoredRight
    if (!item?.height || !beside || !this.layout.isVisible(Parts.ACTIVITYBAR_PART)) return this.defaultTitleHeight
    return Math.round(item.bottom - bar.getBoundingClientRect().top)
  }

  float() {
    if (this.floating) return
    const { workbenchGrid: grid, editorPartView: editor } = this.layout
    const visible = this.visible
    this.width = this.measure()
    const compensate = visible && this.layout.isVisible(Parts.EDITOR_PART, window)
    const editorWidth = compensate ? grid.getViewSize(editor).width : 0
    this.floating = true
    this.constrain(0, 0)
    // The grid hands the freed width to whichever neighbour it likes; the editor is the one to get it.
    if (compensate)
      grid.resizeView(editor, { width: editorWidth + this.width, height: grid.getViewSize(editor).height })
    this.onDidChange()
    if (visible) this.collapse()
  }

  /** Lays the side bar out at the bounds of its grid slot, relative to the grid as the grid itself does. */
  private relayout() {
    const slot = this.view.element.parentElement
    if (!slot) return
    const box = slot.getBoundingClientRect()
    const grid = this.layout.workbenchGrid.element.getBoundingClientRect()
    this.view.layout(box.width, box.height, box.top - grid.top, box.left - grid.left)
  }

  /** Docks the side bar at its pinned width again, showing it if `show` is set. */
  pin(show: boolean) {
    if (!this.floating) return
    // Restoring the constraints and showing the side bar both take room from its neighbours, and the grid picks
    // which; the side bar across the editor keeps the width it has now, so only the editor gives room.
    const grid = this.layout.workbenchGrid
    const other = this.layout[this.spec.other]
    const otherWidth = this.layout.isVisible(this.spec.otherPart) ? grid.getViewSize(other).width : undefined
    this.floating = false
    this.view.element.parentElement?.classList.remove(slotClass(this.spec.id), rightClass)
    this.view.element.style.removeProperty(titleVariable(this.spec.id))
    this.constrain(this.minimumWidth, this.maximumWidth)
    this.onDidChange()
    if (!this.visible) {
      // The grid remembers the zero width the slot had when it was hidden, and shows it again at that width.
      setCachedWidth(grid, this.view, this.width)
      if (show) this.layout.setPartHidden(false, this.spec.part)
    }
    if (this.visible) grid.resizeView(this.view, { width: this.width, height: grid.getViewSize(this.view).height })
    if (otherWidth !== undefined) grid.resizeView(other, { width: otherWidth, height: grid.getViewSize(other).height })
  }

  /**
   * Hides the side bar. Focus inside it goes where the workbench sends it, but focus elsewhere stays: the
   * workbench would move it to the editor even when the side bar is dismissed by focusing the terminal.
   */
  collapse() {
    this.suppressFocus = !this.view.element.contains(document.activeElement)
    try {
      this.layout.setPartHidden(true, this.spec.part)
    } finally {
      this.suppressFocus = false
    }
  }

  reveal() {
    this.layout.setPartHidden(false, this.spec.part)
  }

  private measure() {
    const { workbenchGrid: grid, stateModel } = this.layout
    const width = this.visible
      ? grid.getViewSize(this.view).width
      : grid.getViewCachedVisibleSize(this.view) || stateModel.getInitializationValue({ name: this.spec.sizeKey })
    return typeof width === 'number' && width > 0 ? width : defaultWidth
  }

  private constrain(minimumWidth: number, maximumWidth: number) {
    for (const [key, value] of [
      ['minimumWidth', minimumWidth],
      ['maximumWidth', maximumWidth],
    ] as const) {
      Object.defineProperty(this.view, key, { value, writable: true, configurable: true, enumerable: true })
    }
    this.view._onDidChange.fire(undefined)
  }
}

/**
 * Sets the size a hidden grid view gets when it shows again, which `SplitView` caches when hiding it. The grid
 * exposes only the getter, `Grid.getViewCachedVisibleSize`; this follows the same path to the view item.
 */
function setCachedWidth(grid: LayoutInternals['workbenchGrid'], view: object, width: number) {
  const internal = grid as unknown as {
    getViewLocation(view: object): number[]
    gridview: {
      getNode(location: number[]): [unknown, { splitview?: { viewItems?: { _cachedVisibleSize?: number }[] } }]
    }
  }
  const location = internal.getViewLocation(view)
  const [, parent] = internal.gridview.getNode(location.slice(0, -1))
  const item = parent.splitview?.viewItems?.[location[location.length - 1]!]
  if (item?._cachedVisibleSize === undefined)
    throw new Error('floating-sidebar: the grid no longer caches sizes in view items')
  item._cachedVisibleSize = width
}
