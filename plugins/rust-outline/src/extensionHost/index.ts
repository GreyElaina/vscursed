import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import * as vscode from 'vscode'
import type {} from '../protocol.ts'

export const name = 'rust-outline'
export const inject = ['bridge']

export function apply(ctx: Context) {
  ctx.bridge.provide('extensionHost', 'rust-outline.extensionHost', {
    messages: () => ({
      boilerplate: vscode.l10n.t('Boilerplate'),
      otherImpl: vscode.l10n.t('Other impls'),
    }),
  })
}
