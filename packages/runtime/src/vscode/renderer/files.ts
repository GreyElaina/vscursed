import { DisposableStore } from 'vscode-internal/vs/base/common/lifecycle.js'
import { FileAccess } from 'vscode-internal/vs/base/common/network.js'
import { dirname } from 'vscode-internal/vs/base/common/resources.js'
import { URI } from 'vscode-internal/vs/base/common/uri.js'
import type { IFileService } from 'vscode-internal/vs/platform/files/common/files.js'
import type { FileWatcher } from '../../kernel/host.ts'
import type { ModuleHost } from '../../kernel/modules.ts'

/** Loads plugin modules through the `vscode-file` protocol, which serves extension directories. */
export const rendererModuleHost: ModuleHost = {
  toUrl: path => FileAccess.uriToBrowserUri(URI.file(path)).toString(true),
  import: url => import(/* @vite-ignore */ url),
}

/** The sandboxed renderer has no file system of its own; VS Code's file service watches for it. */
export function fileServiceWatcher(fileService: IFileService): FileWatcher {
  return {
    watch(path, onChange) {
      const resource = URI.file(path)
      const store = new DisposableStore()
      store.add(fileService.watch(dirname(resource)))
      store.add(
        fileService.onDidFilesChange(event => {
          if (event.contains(resource)) onChange()
        }),
      )
      return store
    },
  }
}
