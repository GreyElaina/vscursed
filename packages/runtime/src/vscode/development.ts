import { ProviderRegistration, type PluginManifest, type Realm } from '@vscursed/api'

/** Environment variable through which a Debugger window hands its provider registration to the Target. */
export const developmentEnv = 'VSCURSED_PROVIDER'

/** The registration this Target was launched with; `undefined` outside a Target. */
export function targetRegistration(env: Readonly<Record<string, string | undefined>> | undefined) {
  const value = env?.[developmentEnv]
  return value === undefined ? undefined : ProviderRegistration.parse(JSON.parse(value))
}

export type ProviderConnectionState = 'connecting' | 'connected' | 'disconnected' | 'failed'

/** The Target extension host's view of its provider connection. */
export interface ProviderStatus {
  connection: ProviderConnectionState
  /** The manifest of the provider's latest hello. */
  manifest?: PluginManifest
  /** Realms the provider has built since that hello; all of them makes the connection `connected`. */
  built: Realm[]
  error?: string
}

/** Event `provider` of the extension host: a status change, or a rebuild once connected. */
export type ProviderEvent = { type: 'status'; status: ProviderStatus } | { type: 'built'; realm: Realm }
