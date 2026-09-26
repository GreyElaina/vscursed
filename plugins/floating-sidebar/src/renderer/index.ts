import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import type { IDisposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import { ICommandService } from 'vscode-internal/vs/platform/commands/common/commands.js'
import { IContextKeyService } from 'vscode-internal/vs/platform/contextkey/common/contextkey.js'
import { IHoverService } from 'vscode-internal/vs/platform/hover/browser/hover.js'
import { IKeybindingService } from 'vscode-internal/vs/platform/keybinding/common/keybinding.js'
import { IStorageService, StorageScope, StorageTarget } from 'vscode-internal/vs/platform/storage/common/storage.js'
import { IWebviewService } from 'vscode-internal/vs/workbench/contrib/webview/browser/webview.js'
import { IExtensionService } from 'vscode-internal/vs/workbench/services/extensions/common/extensions.js'
import { IWorkbenchLayoutService } from 'vscode-internal/vs/workbench/services/layout/browser/layoutService.js'
import { ILifecycleService } from 'vscode-internal/vs/workbench/services/lifecycle/common/lifecycle.js'
import { IPaneCompositePartService } from 'vscode-internal/vs/workbench/services/panecomposite/browser/panecomposite.js'
import { z } from 'zod'
import { commands, type SideId, windowChannel } from '../protocol.ts'
import type { KeybindingInternals, LayoutInternals } from './internals.ts'
import { PinButton } from './pin.ts'
import { Popup } from './popup.ts'
import { FloatingSide, primary, secondary } from './side.ts'
import { dragOutClass, openClass, style, widthVariable } from './style.ts'

// Zod compiles validators with `new Function` unless told otherwise; the workbench's Trusted Types policy forbids that.
z.config({ jitless: true })

export const name = 'floating-sidebar'
export const inject = ['bridge', 'interceptor', 'vscode']

export const Config = z.object({
  secondarySideBar: z
    .boolean()
    .default(false)
    .describe('Let the secondary side bar float as well, with a pin of its own.'),
  hoverToReveal: z
    .boolean()
    .default(false)
    .describe('Show the floating primary side bar while the activity bar is hovered.'),
})

type Mode = 'floating' | 'pinned'

const extensionId = 'vscursed.floating-sidebar'
const secondaryContext = 'vscursed.floatingSidebar.secondary'
/** Parts a floating side bar covers or faces; clicking or focusing them dismisses it. */
const covered: Record<SideId, string> = {
  primary: '.part.editor, .part.panel, .part.auxiliarybar',
  secondary: '.part.editor, .part.panel, .part.sidebar',
}
const storageKey = (id: SideId) => `vscursed.floatingSidebar.${id}`

export async function apply(ctx: Context, config: z.output<typeof Config>) {
  const layout = ctx.vscode.get(IWorkbenchLayoutService) as unknown as LayoutInternals
  const storage = ctx.vscode.get(IStorageService)
  const keybindings = ctx.vscode.get(IKeybindingService) as KeybindingInternals
  const hovers = ctx.vscode.get(IHoverService)
  const webviews = ctx.vscode.get(IWebviewService)
  const lifecycle = ctx.vscode.get(ILifecycleService)
  const commandService = ctx.vscode.get(ICommandService)
  const paneComposites = ctx.vscode.get(IPaneCompositePartService)
  const container = layout.mainContainer
  const specs = config.secondarySideBar ? [primary, secondary] : [primary]

  // The manifest the workbench scanned has its command titles translated already.
  const manifest = await ctx.vscode.get(IExtensionService).getExtension(extensionId)
  const titles = new Map(
    (manifest?.contributes?.commands ?? []).map(({ command, title }) => [
      command,
      typeof title === 'string' ? title : title.value,
    ]),
  )
  const label = (id: SideId) => {
    const command = commands[id]
    const title = titles.get(command) ?? command
    const keybinding = keybindings.lookupKeybinding(command)?.getLabel()
    return keybinding ? `${title} (${keybinding})` : title
  }

  ctx.effect(() => {
    const sheet = document.createElement('style')
    sheet.textContent = style(specs.map(spec => spec.id))
    document.head.append(sheet)
    return () => sheet.remove()
  }, 'floating-sidebar: style')

  ctx.effect(() => {
    const key = ctx.vscode.get(IContextKeyService).createKey(secondaryContext, config.secondarySideBar)
    return () => key.reset()
  }, 'floating-sidebar: context key')

  const toggles = new Map<SideId, () => void>()
  for (const spec of specs) {
    const key = storageKey(spec.id)
    const stored = () => storage.get(key, StorageScope.PROFILE, 'floating') as Mode

    let popup: Popup | undefined
    let button: PinButton | undefined
    const side: FloatingSide = new FloatingSide(ctx, layout, lifecycle, spec, () => {
      container.style.setProperty(widthVariable(spec.id), `${side.floatingWidth}px`)
      container.classList.toggle(openClass(spec.id), side.floating && side.visible)
      popup?.reset()
      button?.update()
    })
    const activityBar = spec.id === 'primary' ? layout.activityBarPartView.element : undefined
    popup = new Popup(ctx, side, {
      activityBar,
      hoverToReveal: config.hoverToReveal,
      covered: covered[spec.id],
      dragOutClass: dragOutClass(spec.id),
      container,
      webviews,
      keybindings,
      commands: commandService,
      paneComposites,
    })

    const toggle = () => {
      const mode: Mode = side.floating ? 'pinned' : 'floating'
      storage.store(key, mode, StorageScope.PROFILE, StorageTarget.MACHINE)
      if (mode === 'floating') side.float()
      else side.pin(true)
    }
    toggles.set(spec.id, toggle)
    button = new PinButton(ctx, side, hovers, () => label(spec.id), toggle)

    ctx.effect(() => {
      const listener = layout.onDidChangePartVisibility(({ partId, visible }) => {
        if (partId !== spec.part) return
        container.classList.toggle(openClass(spec.id), side.floating && visible)
        if (!visible) popup.reset()
      })
      return () => listener.dispose()
    }, `floating-sidebar: ${spec.id} visibility`)

    // Other windows follow a pin or float, but only the window where it happened shows the side bar for it.
    ctx.effect(() => {
      const disposables: IDisposable[] = []
      const store = { add: <T extends IDisposable>(disposable: T) => (disposables.push(disposable), disposable) }
      disposables.push(
        storage.onDidChangeValue(
          StorageScope.PROFILE,
          key,
          store as never,
        )(({ external }) => {
          if (!external) return
          if (stored() === 'floating') side.float()
          else side.pin(false)
        }),
      )
      return () => disposables.forEach(disposable => disposable.dispose())
    }, `floating-sidebar: ${spec.id} mode`)

    ctx.effect(
      () => () => {
        container.style.removeProperty(widthVariable(spec.id))
        container.classList.remove(openClass(spec.id))
      },
      `floating-sidebar: ${spec.id} workbench state`,
    )

    if (stored() === 'floating') side.float()
  }

  ctx.bridge.provide('renderer', windowChannel, {
    toggle: id => toggles.get(id)?.(),
  })
}
