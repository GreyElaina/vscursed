import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import { ICommandService } from 'vscode-internal/vs/platform/commands/common/commands.js'
import {
  IStatusbarService,
  StatusbarAlignment,
} from 'vscode-internal/vs/workbench/services/statusbar/browser/statusbar.js'
import { z } from 'zod'

// Zod compiles validators with `new Function` unless told otherwise; the workbench's Trusted Types policy forbids that.
z.config({ jitless: true })

export const name = 'sample-command-log'
export const inject = ['interceptor', 'vscode']

export const Config = z.object({
  ignore: z.array(z.string()).default([]).describe('Command ids that are not counted.'),
})

export function apply(ctx: Context, config: z.output<typeof Config>) {
  const logger = ctx.logger('command-log')
  let count = 0
  const text = () => `$(terminal) ${count} commands`
  const statusbar = ctx.vscode.get(IStatusbarService)
  const entry = statusbar.addEntry(
    { name: 'Command Log', text: text(), ariaLabel: 'Command Log' },
    'sample-command-log.count',
    StatusbarAlignment.RIGHT,
    99,
  )
  ctx.effect(() => () => entry.dispose(), 'command-log status bar entry')

  ctx.interceptor.around(ctx.vscode.get(ICommandService), 'executeCommand', function (next, id, ...args) {
    if (!config.ignore.includes(id)) {
      count++
      entry.update({ name: 'Command Log', text: text(), ariaLabel: 'Command Log' })
      logger.debug('executing %s', id)
    }
    return next(id, ...args)
  })
}
