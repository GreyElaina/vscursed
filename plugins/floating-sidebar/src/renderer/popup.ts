import type { Context } from 'cordis'
import type { IKeyboardEvent } from 'vscode-internal/vs/base/browser/keyboardEvent.js'
import { KeyCode } from 'vscode-internal/vs/base/common/keyCodes.js'
import type { IContextKeyServiceTarget } from 'vscode-internal/vs/platform/contextkey/common/contextkey.js'
import type { ICommandService } from 'vscode-internal/vs/platform/commands/common/commands.js'
import { ResultKind } from 'vscode-internal/vs/platform/keybinding/common/keybindingResolver.js'
import type { IWebviewService } from 'vscode-internal/vs/workbench/contrib/webview/browser/webview.js'
import type { IPaneCompositePartService } from 'vscode-internal/vs/workbench/services/panecomposite/browser/panecomposite.js'
import type { KeybindingInternals } from './internals.ts'
import type { FloatingSide } from './side.ts'

const revealDelay = 300
const leaveDelay = 300

/** Workbench overlays that belong to whatever opened them; interacting with them leaves the side bar alone. */
const overlays =
  '.context-view, .quick-input-widget, .monaco-hover, .workbench-hover-container, .monaco-dialog-modal-block'
/**
 * Text fields in the side bar keep Escape even when no keybinding claims it: it cancels a rename or a search, and
 * code editors (the source control message) have their own uses. A code editor takes input through a
 * `.native-edit-context` element, or a textarea when edit context is off.
 */
const textFields = 'input, textarea, [contenteditable]:not([contenteditable="false"]), .native-edit-context'
/** Clears the selection of the focused list; pointless for a list about to be hidden, so Escape hides it instead. */
const clearList = 'list.clear'

export interface PopupOptions {
  /** The activity bar beside the side bar, if any. */
  activityBar: HTMLElement | undefined
  /** Whether hovering the activity bar shows the side bar. */
  hoverToReveal: boolean
  /** Parts a floating side bar covers or sits next to: clicking or focusing them dismisses it. */
  covered: string
  dragOutClass: string
  container: HTMLElement
  webviews: IWebviewService
  keybindings: KeybindingInternals
  commands: ICommandService
  paneComposites: IPaneCompositePartService
}

/**
 * When a floating side bar shows and hides. Showing is the workbench's own (commands, activity bar clicks,
 * views being revealed), plus hovering the activity bar when enabled; toggling it on also focuses it. A side bar
 * shown by hovering hides once the pointer leaves it and the activity bar, unless it was used meanwhile; any
 * shown side bar hides when the parts it covers are clicked or focused, after something dragged out of it is
 * dropped, and on an Escape that nothing else claims.
 */
export class Popup {
  /** Shown by hovering and not used since. */
  private peeking = false
  private dragging = false
  private draggedOut = false
  private revealTimer: ReturnType<typeof setTimeout> | undefined
  private leaveTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Where the last key press started, taken before the focused element handles it: a rename box that Escape
   * cancels is gone from the side bar by the time the keybinding service sees the key press.
   */
  private pressed: { event: KeyboardEvent; inCard: boolean; inTextField: boolean } | undefined
  private readonly activityBar: HTMLElement | undefined
  private readonly hoverToReveal: boolean
  private readonly covered: string
  private readonly dragOutClass: string
  private readonly container: HTMLElement

  constructor(
    ctx: Context,
    private readonly side: FloatingSide,
    {
      activityBar,
      hoverToReveal,
      covered,
      dragOutClass,
      container,
      webviews,
      keybindings,
      commands,
      paneComposites,
    }: PopupOptions,
  ) {
    this.activityBar = activityBar
    this.hoverToReveal = hoverToReveal
    this.covered = covered
    this.dragOutClass = dragOutClass
    this.container = container
    const listen = <K extends keyof DocumentEventMap>(type: K, listener: (event: DocumentEventMap[K]) => void) =>
      ctx.effect(() => {
        document.addEventListener(type, listener, true)
        return () => document.removeEventListener(type, listener, true)
      }, `floating-sidebar: ${side.spec.id} ${type}`)

    listen('pointerover', event => this.onPointer(event.target))
    listen('pointerout', event => {
      if (event.relatedTarget === null) this.onPointer(null)
    })
    listen('pointerdown', event => this.onPress(event.target))
    listen('focusin', event => this.onFocus(event.target))
    listen('dragstart', event => this.onDragStart(event.target))
    listen('dragover', event => this.onDragOver(event.target))
    listen('dragend', () => this.onDragEnd())
    listen('keydown', event => {
      const { target } = event
      if (event.key !== 'Escape' || !this.active || !(target instanceof Element)) return
      const inCard = this.inCard(target)
      this.pressed = { event, inCard, inTextField: inCard && !!target.closest(textFields) }
    })

    // A webview takes focus inside its own frame, which the workbench's document never sees as focus events.
    ctx.effect(() => {
      const listener = webviews.onDidChangeActiveWebview(webview => {
        const frame = document.activeElement
        if (webview && frame instanceof HTMLIFrameElement) this.onFocus(frame)
      })
      return () => listener.dispose()
    }, `floating-sidebar: ${side.spec.id} webview focus`)

    const popup = this

    // Toggling a side bar on leaves the focus where it was, in the editor a floating side bar covers now. One
    // shown on purpose takes the focus as one opened from the activity bar does, and hiding it gives the focus
    // back to the editor.
    ctx.interceptor.around(commands, 'executeCommand', async function (next, id, ...args) {
      const shown = side.visible
      const result = await next(id, ...args)
      if (id === side.spec.toggleCommand && !shown && popup.active)
        paneComposites.getActivePaneComposite(side.spec.location)?.focus()
      return result
    })

    // Every key press reaches the keybinding service after the focused element has had it, so Escape can be
    // left to whatever the workbench or the element does with it, and taken only when neither does anything.
    ctx.interceptor.around(keybindings, '_dispatch', function (next, event, target) {
      return popup.onEscape(this, event, target) || next(event, target)
    })

    ctx.effect(
      () => () => {
        clearTimeout(this.revealTimer)
        clearTimeout(this.leaveTimer)
        this.container.classList.remove(this.dragOutClass)
      },
      `floating-sidebar: ${side.spec.id} timers`,
    )
  }

  /** Forgets how the side bar was shown; called whenever it hides or its mode changes. */
  reset() {
    this.peeking = false
    clearTimeout(this.revealTimer)
    clearTimeout(this.leaveTimer)
    this.revealTimer = this.leaveTimer = undefined
  }

  private get active() {
    return this.side.floating && this.side.visible
  }

  /** Webviews are drawn over their views from outside them, so a webview frame is placed by where it is. */
  private inCard(target: EventTarget | null) {
    const region = this.side.region
    if (!region || !(target instanceof Element)) return false
    if (!(target instanceof HTMLIFrameElement)) return region.contains(target)
    const frame = target.getBoundingClientRect()
    const card = region.getBoundingClientRect()
    const x = frame.left + frame.width / 2
    const y = frame.top + frame.height / 2
    return x >= card.left && x <= card.right && y >= card.top && y <= card.bottom
  }

  private inActivityBar(target: EventTarget | null) {
    return target instanceof Node && !!this.activityBar?.contains(target)
  }

  private inCovered(target: EventTarget | null) {
    return target instanceof Element && !!target.closest(this.covered) && !target.closest(overlays)
  }

  private onPointer(target: EventTarget | null) {
    const onActivityBar = this.inActivityBar(target)
    if (this.hoverToReveal && this.side.floating && !this.side.visible && onActivityBar) {
      this.revealTimer ??= setTimeout(() => {
        this.revealTimer = undefined
        if (!this.side.floating || this.side.visible) return
        this.side.reveal()
        this.peeking = true
      }, revealDelay)
    } else {
      clearTimeout(this.revealTimer)
      this.revealTimer = undefined
    }

    if (!this.active || !this.peeking) return
    if (onActivityBar || this.inCard(target)) {
      clearTimeout(this.leaveTimer)
      this.leaveTimer = undefined
    } else if (!(target instanceof Element && target.closest(overlays))) {
      this.leaveTimer ??= setTimeout(() => {
        this.leaveTimer = undefined
        if (this.active && this.peeking) this.side.collapse()
      }, leaveDelay)
    }
  }

  private onPress(target: EventTarget | null) {
    if (!this.active) return
    if (this.inCard(target)) this.peeking = false
    else if (this.inCovered(target)) this.side.collapse()
  }

  /**
   * Hides the side bar on an Escape nothing else claims, wherever the focus is: showing the side bar leaves it
   * where it was unless the view that opened takes it, and focusing what the side bar covers hides it anyway.
   */
  private onEscape(keybindings: KeybindingInternals, event: IKeyboardEvent, target: IContextKeyServiceTarget) {
    if (!this.active || event.keyCode !== KeyCode.Escape) return false
    if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return false
    const { browserEvent } = event
    if (browserEvent.isComposing || browserEvent.defaultPrevented) return false
    const element = event.target
    if (!(element instanceof Element) || element.closest(overlays)) return false
    // Key presses webviews forward are dispatched straight to the window, past the document's listener.
    const pressed = this.pressed?.event === browserEvent ? this.pressed : undefined
    const inCard = pressed?.inCard ?? this.inCard(element)
    if (pressed?.inTextField ?? (inCard && element.closest(textFields))) return false
    const result = keybindings.softDispatch(event, target)
    if (result.kind === ResultKind.MoreChordsNeeded) return false
    if (result.kind === ResultKind.KbFound && !(inCard && result.commandId === clearList)) return false
    this.side.collapse()
    return true
  }

  private onFocus(target: EventTarget | null) {
    if (!this.active) return
    if (this.inCard(target)) this.peeking = false
    else if (this.inCovered(target) || target instanceof HTMLIFrameElement) this.side.collapse()
  }

  private onDragStart(target: EventTarget | null) {
    if (!this.active || !this.inCard(target)) return
    this.dragging = true
    this.draggedOut = false
    this.peeking = false
  }

  /** Something dragged out of the card is meant for what the card covers, so the card gets out of the way. */
  private onDragOver(target: EventTarget | null) {
    if (!this.dragging || this.draggedOut || this.inCard(target) || this.inActivityBar(target)) return
    this.draggedOut = true
    this.container.classList.add(this.dragOutClass)
  }

  private onDragEnd() {
    if (!this.dragging) return
    this.dragging = false
    this.container.classList.remove(this.dragOutClass)
    if (this.draggedOut && this.active) this.side.collapse()
    this.draggedOut = false
  }
}
