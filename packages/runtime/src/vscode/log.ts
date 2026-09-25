import type { Realm } from '@vscursed/api'
import type { ILogger, ILoggerService, LoggerGroup } from 'vscode-internal/vs/platform/log/common/log.js'
import type { LogLevel } from '../kernel/realm.ts'

/**
 * The Output entry that VS Code composes from the loggers of this group: one source per realm, merged
 * by time and tagged with the source name.
 */
const group: LoggerGroup = { id: 'vscursed', name: 'VSCursed' }

/**
 * The realm's log file under the process's logs folder. VS Code registers it with the windows that the
 * process serves: every window for main and shared process, the own window for renderer and extension host.
 *
 * The source name is the realm id: Node processes create spdlog loggers keyed by name, and a name that
 * VS Code already uses ("Extension Host") would write into that process's own log.
 */
export function createRealmLogger(loggerService: ILoggerService, realm: Realm): ILogger {
  return loggerService.createLogger(`vscursed.${realm}`, { name: realm, group })
}

export function logTo(logger: ILogger) {
  return (level: LogLevel, message: string) => logger[level](message)
}
