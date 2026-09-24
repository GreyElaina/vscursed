import { realms, type PluginDescriptor, type Realm } from '@vscursed/api'

function sameDescriptor(left: PluginDescriptor, right: PluginDescriptor, realm?: Realm) {
  if (left.id !== right.id || left.location !== right.location) return false
  if (realm) return left.manifest[realm] === right.manifest[realm]
  return (
    left.displayName === right.displayName &&
    left.description === right.description &&
    realms.every(realm => left.manifest[realm] === right.manifest[realm])
  )
}

/** Whether two ordered plugin lists describe the same enabled extensions and realm modules. */
export function samePluginDescriptors(
  left: readonly PluginDescriptor[],
  right: readonly PluginDescriptor[],
  realm?: Realm,
) {
  return (
    left.length === right.length && left.every((descriptor, index) => sameDescriptor(descriptor, right[index]!, realm))
  )
}

/** Whether the plugins currently loaded by one realm have the same module sources. */
export function sameRealmPlugins(left: readonly PluginDescriptor[], right: readonly PluginDescriptor[], realm: Realm) {
  return samePluginDescriptors(
    left.filter(descriptor => descriptor.manifest[realm]),
    right.filter(descriptor => descriptor.manifest[realm]),
    realm,
  )
}
