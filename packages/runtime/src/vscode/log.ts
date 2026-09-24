import type { ILogService } from 'vscode-internal/vs/platform/log/common/log.js'
import type { LogLevel } from '../kernel/realm.ts'

export function logTo(logService: ILogService) {
  return (level: LogLevel, message: string) => logService[level](`[VSCursed] ${message}`)
}
