import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import * as vscode from 'vscode'
import { commands } from '../protocol.ts'
import { SupermavenStatus } from './status.ts'

export const name = 'supermaven'
export const inject = ['bridge']

/**
 * Extension-host half of Supermaven: the commands the manifest contributes, registered through this
 * extension's own API instance and carried out by the window's renderer.
 */
export function apply(ctx: Context) {
  const renderer = ctx.bridge.connect('renderer', 'supermaven.window')
  const channel = ctx.bridge.connect('sharedProcess', 'supermaven')
  const status = new SupermavenStatus(ctx, channel, renderer)
  ctx.bridge.provide('extensionHost', 'supermaven.extensionHost', {
    messages: () => ({ accept: vscode.l10n.t('Accept'), preview: vscode.l10n.t('Preview') }),
    updatePresentation: presentation => status.updatePresentation(presentation),
  })
  const registrations = [
    vscode.commands.registerCommand(commands.acceptLine, async () => {
      await ctx.bridge.ready('renderer', 'supermaven.window')
      await renderer.acceptLine()
    }),
    vscode.commands.registerCommand(commands.restart, async () => {
      await ctx.bridge.ready('renderer', 'supermaven.window')
      await status.restart()
    }),
    vscode.commands.registerCommand(commands.showStatus, () => status.show()),
  ]
  ctx.effect(() => () => registrations.forEach(registration => registration.dispose()), 'supermaven commands')
}
