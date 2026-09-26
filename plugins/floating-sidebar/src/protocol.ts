import type { ChannelSpec } from '@vscursed/api'

export type SideId = 'primary' | 'secondary'

/** Command ids, also listed under `contributes` in the manifest. */
export const commands: Record<SideId, string> = {
  primary: 'vscursed.floatingSidebar.togglePrimary',
  secondary: 'vscursed.floatingSidebar.toggleSecondary',
}

/** What the extension host asks of the window its commands run in. */
export interface FloatingSidebarWindow {
  /** Pins a floating side bar or floats a pinned one; a side bar the plugin does not manage is left alone. */
  toggle(id: SideId): void
}

export const windowChannel = 'floating-sidebar.window'

declare module '@vscursed/api' {
  interface Channels {
    'floating-sidebar.window': ChannelSpec<'renderer', FloatingSidebarWindow>
  }
}
