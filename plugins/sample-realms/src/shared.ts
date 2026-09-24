import type { ChannelSpec, Event } from '@vscursed/api'
import { z } from 'zod'

// Zod compiles validators with `new Function` unless told otherwise; the workbench's Trusted Types policy forbids that.
z.config({ jitless: true })

/** One entry configures every realm; each realm reads the keys it uses. */
export const Config = z.object({
  label: z.string().default('VSCursed').describe('Text in front of the clock in the status bar.'),
  interval: z
    .number()
    .int()
    .min(100)
    .default(1000)
    .describe('Milliseconds between clock ticks from the shared process.'),
})

export type Config = z.output<typeof Config>

export interface ProcessDescription {
  realm: string
  pid: number
  detail: string
}

declare module '@vscursed/api' {
  interface Channels {
    'sample.clock': ChannelSpec<'sharedProcess', { now(): number; onTick: Event<number> }>
    'sample.main': ChannelSpec<'main', { describe(): ProcessDescription }>
    'sample.extensionHost': ChannelSpec<'extensionHost', { describe(): Promise<ProcessDescription> }>
  }
}
