import { z } from 'zod/mini'
import { PluginManifest } from './manifest.ts'
import { realms } from './realm.ts'

export const providerProtocol = 3

const nonEmpty = () => z.string().check(z.minLength(1))

/** A Vite+ provider workspace that a VSCursed profile trusts, keyed by its extension. */
export const ProviderAuthorization = z.object({
  extensionId: nonEmpty(),
  workspace: nonEmpty(),
})

export type ProviderAuthorization = z.infer<typeof ProviderAuthorization>

export const ProviderAuthorizations = z.array(ProviderAuthorization)

/** What the `vscodium://vscursed/provider/import` URI printed by a Vite+ provider carries. */
export const ProviderRegistration = z.extend(ProviderAuthorization, {
  endpoint: nonEmpty(),
})

export type ProviderRegistration = z.infer<typeof ProviderRegistration>

/**
 * Sent on connection and whenever the provider's manifest changes; it resets the realms built on
 * the connection. The manifest is authoritative for the extension while the provider is connected.
 */
export const ProviderHello = z.object({
  protocol: z.literal(providerProtocol),
  extensionId: nonEmpty(),
  workspace: nonEmpty(),
  manifest: PluginManifest,
})

export type ProviderHello = z.infer<typeof ProviderHello>

/** A realm's module was rebuilt; identity comes from the connection's hello. */
export const ProviderBuilt = z.object({
  realm: z.enum(realms),
})

export type ProviderBuilt = z.infer<typeof ProviderBuilt>
