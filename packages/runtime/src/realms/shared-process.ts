import type { start as Start } from 'vscode-internal/vs/vscursed/runtime/sharedProcess.js'
import { ISharedProcessLifecycleService } from 'vscode-internal/vs/platform/lifecycle/node/sharedProcessLifecycleService.js'
import { startApplicationRealm } from '../vscode/application.ts'

export const start: typeof Start = (instantiationService, server) => {
  const handle = startApplicationRealm('sharedProcess', instantiationService, server)
  const lifecycleService = instantiationService.invokeFunction(accessor => accessor.get(ISharedProcessLifecycleService))
  // The main process does not wait for the shared process to exit, so its teardown is best effort.
  lifecycleService.onWillShutdown(() => void handle.dispose())
}
