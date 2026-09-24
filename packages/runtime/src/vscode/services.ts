import type { ServiceRegistry } from '@vscursed/api'
import { _util } from 'vscode-internal/vs/platform/instantiation/common/instantiation.js'

/**
 * Service identifiers by the id given to `createDecorator`. Plugin bundles resolve their
 * `vscode-internal` service imports here, so they hold the identifiers the realm's container uses.
 */
export const services: ServiceRegistry = {
  service(id) {
    const identifier = _util.serviceIds.get(id)
    if (!identifier) throw new Error(`VS Code service "${id}" is not registered in this realm`)
    return identifier
  },
}
