import type { ChannelSpec, Event } from '@vscursed/api'

/** One item of an sm-agent answer, as its stdio protocol names it. */
export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'dedent'; text: string }
  | { kind: 'jump'; file_name: string; line_number: number; verify: string | null; is_create_file: boolean }
  | { kind: 'delete'; verify: string }
  | { kind: 'skip'; n: number }
  | { kind: 'barrier' }
  | { kind: 'finish_edit' }
  | { kind: 'end' }

/** What a renderer knows about a document when it asks for a completion at the caret. */
export interface CompletionRequest {
  /** Directory that sm-agent runs in; one agent serves each. */
  workspace: string
  /** Path of the document relative to `workspace`. */
  file: string
  content: string
  /** Caret position in UTF-8 bytes. */
  byteOffset: number
  /** Identifies the document state; asking again with the same key reuses the answer. */
  key: string
}

export interface CompletionReply {
  tokens: Token[]
  /** The answer is still streaming: only its first complete line can be relied on. */
  incomplete: boolean
}

export type Connection = 'starting' | 'connected' | 'disconnected' | 'exited'

export interface AgentStatus {
  connection: Connection
  tier: string | null
  email: string | null
}

export interface StatusChange {
  workspace: string
  status: AgentStatus
}

export interface CompletionPresentation {
  fetching: boolean
  available: boolean
  answeredAt: number | null
}

export interface RendererMessages {
  accept: string
  preview: string
}

/** The shared process runs one sm-agent per workspace and serves every window through this channel. */
export interface SupermavenChannel {
  complete(request: CompletionRequest): Promise<CompletionReply>
  /** The final tokens of an answer that is known or still streaming, without starting a new one. */
  resume(workspace: string, key: string): Promise<Token[] | null>
  status(workspace: string): Promise<AgentStatus>
  restart(): Promise<void>
  onDidChangeStatus: Event<StatusChange>
}

/**
 * What a window's commands do, served by its renderer. The commands are registered through the
 * extension API in the window's extension host, which is where VS Code runs extension commands.
 */
export interface SupermavenWindow {
  /** Inserts the next line of the answer at the caret of the focused editor. */
  acceptLine(): Promise<void>
  restart(): Promise<void>
}

/** Public extension UI and localization, owned by this extension's API instance. */
export interface SupermavenExtensionHost {
  messages(): RendererMessages
  updatePresentation(presentation: CompletionPresentation): void
}

declare module '@vscursed/api' {
  interface Channels {
    supermaven: ChannelSpec<'sharedProcess', SupermavenChannel>
    'supermaven.window': ChannelSpec<'renderer', SupermavenWindow>
    'supermaven.extensionHost': ChannelSpec<'extensionHost', SupermavenExtensionHost>
  }
}

/** Command ids, also listed under `contributes` in the manifest. */
export const commands = {
  acceptLine: 'vscursed.supermaven.acceptLine',
  restart: 'vscursed.supermaven.restart',
  showStatus: 'vscursed.supermaven.showStatus',
} as const

/** Context key that enables the ⌥⇥ keybinding: the focused editor has a line to accept. */
export const lineReadyContext = 'vscursed.supermaven.lineReady'

/** The text an answer's tokens spell out so far. */
export function tokenText(tokens: readonly Token[]): string {
  let text = ''
  for (const token of tokens) if (token.kind === 'text') text += token.text
  return text
}
