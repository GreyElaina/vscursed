import { FileAccess } from 'vscode-internal/vs/base/common/network.js'
import { URI } from 'vscode-internal/vs/base/common/uri.js'
import type { ModuleHost } from '../../kernel/modules.ts'

/** Loads plugin modules through the `vscode-file` protocol, which serves extension directories. */
export const rendererModuleHost: ModuleHost = {
  toUrl: path => FileAccess.uriToBrowserUri(URI.file(path)).toString(true),
  import: url => import(/* @vite-ignore */ url),
}
