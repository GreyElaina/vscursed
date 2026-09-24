/**
 * The VS Code processes that host a Cordis context. Renderer and extension host belong to one window;
 * main and shared process serve every window of the application.
 */
export type Realm = 'renderer' | 'main' | 'sharedProcess' | 'extensionHost'

export const realms: readonly Realm[] = ['renderer', 'main', 'sharedProcess', 'extensionHost']

export function isRealm(value: unknown): value is Realm {
  return realms.includes(value as Realm)
}
