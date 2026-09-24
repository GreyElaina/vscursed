import { watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FileWatcher } from '../kernel/host.ts'
import type { ModuleHost } from '../kernel/modules.ts'

export const nodeModuleHost: ModuleHost = {
  toUrl: path => pathToFileURL(path).href,
  import: url => import(url),
}

/**
 * Watches the directory rather than the file: bundlers replace output files, which ends a watch on
 * the old inode.
 */
export const nodeWatcher: FileWatcher = {
  watch(path, onChange) {
    const name = basename(path)
    const watcher = watch(dirname(path), (_, file) => {
      if (file === name) onChange()
    })
    watcher.on('error', () => watcher.close())
    return { dispose: () => watcher.close() }
  },
}
