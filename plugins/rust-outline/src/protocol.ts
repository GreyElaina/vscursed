import type { ChannelSpec } from '@vscursed/api'

export interface RustOutlineMessages {
  boilerplate: string
  otherImpl: string
}

export interface RustOutlineExtensionHost {
  messages(): RustOutlineMessages
}

declare module '@vscursed/api' {
  interface Channels {
    'rust-outline.extensionHost': ChannelSpec<'extensionHost', RustOutlineExtensionHost>
  }
}
