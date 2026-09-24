import type { start as Start } from 'vscode-internal/vs/vscursed/runtime/main.js'
import { ILifecycleMainService } from 'vscode-internal/vs/platform/lifecycle/electron-main/lifecycleMainService.js'
import { startApplicationRealm } from '../vscode/application.ts'

export const start: typeof Start = (instantiationService, server) => {
  const handle = startApplicationRealm('main', instantiationService, server)
  const lifecycleMainService = instantiationService.invokeFunction(accessor => accessor.get(ILifecycleMainService))
  lifecycleMainService.onWillShutdown(event => event.join('vscursed', handle.dispose()))
}
