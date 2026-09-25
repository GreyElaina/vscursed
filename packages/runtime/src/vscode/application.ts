import type { IPCServer } from 'vscode-internal/vs/base/parts/ipc/common/ipc.js'
import { IConfigurationService } from 'vscode-internal/vs/platform/configuration/common/configuration.js'
import type { IInstantiationService } from 'vscode-internal/vs/platform/instantiation/common/instantiation.js'
import { ILoggerService } from 'vscode-internal/vs/platform/log/common/log.js'
import { startRealm } from '../kernel/realm.ts'
import { channelName, channelTransport, RealmServer } from './channel.ts'
import { NodeDebugEndpoints } from './debug.ts'
import { WindowDemand } from './demand.ts'
import { createRealmLogger, logTo } from './log.ts'
import { nodeModuleHost } from './node.ts'
import { services } from './services.ts'
import { configurationSettings } from './settings.ts'

/**
 * A realm that serves all windows (main or shared process): it loads the plugins that any connected
 * window enables and reads their settings from the user configuration.
 */
export function startApplicationRealm(
  realm: 'main' | 'sharedProcess',
  instantiationService: IInstantiationService,
  server: IPCServer<string>,
) {
  const [configurationService, loggerService] = instantiationService.invokeFunction(accessor => [
    accessor.get(IConfigurationService),
    accessor.get(ILoggerService),
  ])
  const demand = new WindowDemand()
  const debug = new NodeDebugEndpoints()
  const handle = startRealm({
    realm,
    instantiationService,
    services,
    transport: channelTransport(realm, () => undefined),
    modules: nodeModuleHost,
    plugins: demand,
    settings: configurationSettings(configurationService),
    log: logTo(createRealmLogger(loggerService, realm)),
  })
  server.registerChannel(
    channelName,
    new RealmServer({
      realm,
      handle,
      demand: (client, plugins) => demand.set(client, plugins),
      debug,
    }),
  )
  server.onDidRemoveConnection(connection => {
    demand.delete(connection.ctx)
    debug.releaseClient(connection.ctx)
  })
  return {
    ...handle,
    async dispose() {
      debug.dispose()
      await handle.dispose()
    },
  }
}
