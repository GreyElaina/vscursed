import { readPluginManifest, type Realm } from '@vscursed/api'
import { Disposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import { joinPath } from 'vscode-internal/vs/base/common/resources.js'
import type { IFileService } from 'vscode-internal/vs/platform/files/common/files.js'
import type { ILogService } from 'vscode-internal/vs/platform/log/common/log.js'
import { Severity, type INotificationService } from 'vscode-internal/vs/platform/notification/common/notification.js'
import type { IWorkbenchExtensionManagementService } from 'vscode-internal/vs/workbench/services/extensionManagement/common/extensionManagement.js'

/**
 * Checks each newly installed extension for a Cordis plugin: a malformed `vscursed` field or a missing
 * realm module is reported at installation instead of surfacing later as a load failure in one process.
 */
export class InstallProbe extends Disposable {
  constructor(
    extensionManagementService: IWorkbenchExtensionManagementService,
    private readonly fileService: IFileService,
    private readonly notificationService: INotificationService,
    private readonly logService: ILogService,
  ) {
    super()
    this._register(
      extensionManagementService.onDidInstallExtensions(results => {
        for (const { local } of results) {
          if (local) void this.probe(local.identifier.id, local.location, local.manifest)
        }
      }),
    )
  }

  private async probe(id: string, location: Parameters<typeof joinPath>[0], manifest: object) {
    let realms: Realm[]
    try {
      const plugin = readPluginManifest(manifest)
      if (!plugin) return
      realms = Object.keys(plugin) as Realm[]
      const missing: string[] = []
      for (const realm of realms) {
        if (!(await this.fileService.exists(joinPath(location, plugin[realm]!))))
          missing.push(`${realm} (${plugin[realm]})`)
      }
      if (missing.length) throw new Error(`missing modules: ${missing.join(', ')}`)
    } catch (error) {
      this.notificationService.notify({
        severity: Severity.Error,
        message: `${id} declares a VSCursed plugin that cannot load: ${(error as Error).message}`,
      })
      return
    }
    this.logService.info(`[VSCursed] installed Cordis plugin ${id} for ${realms.join(', ')}`)
  }
}
