/**
 * The modules a realm shares with the plugin bundles it loads. Plugin bundles keep these specifiers
 * external and read them from the realm's table, so a plugin sees the realm's own Cordis and
 * VSCursed classes, symbols and services instead of private copies.
 */
export const sharedSpecifiers = ['cordis', '@vscursed/api'] as const

export type SharedSpecifier = (typeof sharedSpecifiers)[number]

/** Global under which a realm installs its {@link SharedModules}. */
export const sharedModulesKey = Symbol.for('vscursed.shared')

/** Resolves VS Code service identifiers by the id passed to `createDecorator`. */
export interface ServiceRegistry {
  service(id: string): unknown
}

export interface SharedModules {
  modules: Record<SharedSpecifier, object>
  vscode: ServiceRegistry
}
