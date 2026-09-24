import { pathToFileURL } from 'node:url'
import type { ModuleHost } from '../kernel/modules.ts'

export const nodeModuleHost: ModuleHost = {
  toUrl: path => pathToFileURL(path).href,
  import: url => import(url),
}
