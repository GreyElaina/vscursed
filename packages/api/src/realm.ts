/**
 * The VS Code processes that host a Cordis context. Renderer and extension host belong to one window;
 * main and shared process serve every window of the application.
 */
export const realms = ['renderer', 'main', 'sharedProcess', 'extensionHost'] as const

export type Realm = (typeof realms)[number]

export function isRealm(value: unknown): value is Realm {
  return realms.includes(value as Realm)
}
