import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import { ICommandService } from 'vscode-internal/vs/platform/commands/common/commands.js'
import { INotificationService } from 'vscode-internal/vs/platform/notification/common/notification.js'
import {
  IStatusbarService,
  StatusbarAlignment,
} from 'vscode-internal/vs/workbench/services/statusbar/browser/statusbar.js'
import type { Config } from './shared.ts'

export { Config } from './shared.ts'

export const name = 'sample-realms'
export const inject = ['bridge', 'interceptor', 'vscode']

const command = 'sample-realms.describe'

export function apply(ctx: Context, config: Config) {
  const clock = ctx.bridge.connect('sharedProcess', 'sample.clock')
  const format = (now: number) => `$(clock) ${config.label} ${new Date(now).toLocaleTimeString()}`

  const statusbar = ctx.vscode.get(IStatusbarService)
  ctx.effect(() => {
    const entry = statusbar.addEntry(
      { name: config.label, text: format(Date.now()), ariaLabel: config.label, command },
      'sample-realms.clock',
      StatusbarAlignment.RIGHT,
      100,
    )
    const tick = clock.onTick(now =>
      entry.update({ name: config.label, text: format(now), ariaLabel: config.label, command }),
    )
    return () => {
      tick.dispose()
      entry.dispose()
    }
  }, 'sample-realms status bar entry')

  // The status bar entry runs this command; its implementation is a layer around the command service.
  const notifications = ctx.vscode.get(INotificationService)
  ctx.interceptor.around(ctx.vscode.get(ICommandService), 'executeCommand', async function (next, id, ...args) {
    if (id !== command) return next(id, ...args)
    const [main, extensionHost, now] = await Promise.all([
      ctx.bridge.connect('main', 'sample.main').describe(),
      ctx.bridge.connect('extensionHost', 'sample.extensionHost').describe(),
      clock.now(),
    ])
    notifications.info(
      [main, extensionHost].map(({ realm, pid, detail }) => `${realm} (pid ${pid}): ${detail}`).join(' · ') +
        ` · sharedProcess clock: ${new Date(now).toLocaleTimeString()}`,
    )
    return undefined
  })
}
