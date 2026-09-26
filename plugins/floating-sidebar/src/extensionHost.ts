import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import * as vscode from 'vscode'
import { commands, type SideId, windowChannel } from './protocol.ts'

export const name = 'floating-sidebar'
export const inject = ['bridge']

/** Registers the commands the manifest contributes; the window's renderer carries them out. */
export function apply(ctx: Context) {
  const renderer = ctx.bridge.connect('renderer', windowChannel)
  const registrations = (Object.entries(commands) as [SideId, string][]).map(([id, command]) =>
    vscode.commands.registerCommand(command, async () => {
      await ctx.bridge.ready('renderer', windowChannel)
      await renderer.toggle(id)
    }),
  )
  ctx.effect(() => () => registrations.forEach(registration => registration.dispose()), 'floating-sidebar commands')
}
