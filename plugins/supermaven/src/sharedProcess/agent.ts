import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import type { Config } from '../config.ts'
import { tokenText, type AgentStatus, type CompletionReply, type CompletionRequest, type Token } from '../protocol.ts'

const TokenSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('dedent'), text: z.string() }),
  z.object({
    kind: z.literal('jump'),
    file_name: z.string(),
    line_number: z.number().int(),
    verify: z.string().nullable(),
    is_create_file: z.boolean(),
  }),
  z.object({ kind: z.literal('delete'), verify: z.string() }),
  z.object({ kind: z.literal('skip'), n: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('barrier') }),
  z.object({ kind: z.literal('finish_edit') }),
  z.object({ kind: z.literal('end') }),
]) satisfies z.ZodType<Token>

const MessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('response'), stateId: z.union([z.string(), z.number()]), items: z.array(TokenSchema) }),
  z.object({ kind: z.literal('connection_status'), is_connected: z.boolean() }),
  z.object({
    kind: z.literal('user_status'),
    tier: z.string().nullish(),
    email: z.string().nullish(),
  }),
  z.looseObject({ kind: z.literal('error') }),
])

type Message = z.output<typeof MessageSchema>

const messagePrefix = 'SM-MESSAGE '
const messageKinds = new Set<unknown>(MessageSchema.options.map(option => option.shape.kind.value))
/** Final answers kept per agent, so that a document state asked for again is answered at once. */
const answerCacheSize = 8

export type AgentOptions = Pick<
  Config,
  | 'homeDirectory'
  | 'extensionVersion'
  | 'editorVersion'
  | 'allowGitignore'
  | 'responseWindowMs'
  | 'answerWindowMs'
  | 'retryMaxMs'
  | 'requestTimeoutMs'
  | 'connectTimeoutMs'
>

export interface AgentLog {
  info(message: string): void
  warn(message: string): void
  error(error: unknown): void
}

type Update =
  | { kind: 'file_update'; path: string; content: string }
  | { kind: 'cursor_update'; path: string; offset: number }

/** One document state sent to sm-agent, with the answer streaming back for it. */
interface State {
  readonly id: string
  readonly key: string
  readonly updates: Update[]
  tokens: Token[]
  /** The first complete line went out as the reply; the rest streams into `final`. */
  delivered: boolean
  readonly reply: PromiseWithResolvers<CompletionReply>
  readonly final: PromiseWithResolvers<Token[]>
  deadline?: ReturnType<typeof setTimeout>
  resend?: ReturnType<typeof setTimeout>
  quiet?: ReturnType<typeof setTimeout>
}

/**
 * Streamed answers sometimes repeat the text sent so far in full, and sometimes only continue it. A
 * repeat replaces the earlier text tokens; a continuation is appended.
 */
export function mergeTokens(previous: readonly Token[], incoming: readonly Token[]): Token[] {
  const before = tokenText(previous)
  if (!before || !tokenText(incoming).startsWith(before)) return [...previous, ...incoming]
  return [...previous.filter(token => token.kind !== 'text'), ...incoming]
}

/** Whether the answer holds a complete line of text, not counting the line breaks it starts with. */
export function hasCompleteLine(tokens: readonly Token[]): boolean {
  return tokenText(tokens).replace(/^\n+/, '').includes('\n')
}

/** One `sm-agent` process for one workspace, multiplexing document states over its stdio protocol. */
export class Agent {
  status: AgentStatus = { connection: 'starting', tier: null, email: null }
  private child: ChildProcess | undefined
  private readonly states = new Map<string, State>()
  private readonly streaming = new Map<string, State>()
  /** Final answers by key, oldest first. */
  private readonly answers = new Map<string, Token[]>()
  /** Files that sm-agent has been told about since it started. */
  private readonly announced = new Set<string>()
  private sequence = 0
  /** The most recent state; a newer request makes it pointless while it has not answered. */
  private latest: State | undefined
  /** A state sent before sm-agent connected, which it may have dropped. */
  private unconfirmed: State | undefined

  constructor(
    readonly workspace: string,
    private readonly binary: string,
    private readonly options: AgentOptions,
    private readonly log: AgentLog,
    private readonly onStatus: (status: AgentStatus) => void,
  ) {
    this.start()
  }

  restart() {
    this.stop(new Error('sm-agent restarted'))
    this.start()
  }

  dispose() {
    this.stop(new Error('sm-agent stopped'))
    this.updateStatus({ connection: 'exited' })
  }

  complete(request: CompletionRequest): Promise<CompletionReply> {
    const answer = this.answers.get(request.key)
    if (answer) return Promise.resolve({ tokens: answer, incomplete: false })
    const streaming = this.streaming.get(request.key)
    if (streaming) {
      return streaming.delivered
        ? Promise.resolve({ tokens: streaming.tokens, incomplete: true })
        : streaming.reply.promise
    }
    this.supersede()
    const state: State = {
      id: String(++this.sequence),
      key: request.key,
      updates: [
        { kind: 'file_update', path: request.file, content: request.content },
        { kind: 'cursor_update', path: request.file, offset: request.byteOffset },
      ],
      tokens: [],
      delivered: false,
      reply: Promise.withResolvers(),
      final: Promise.withResolvers(),
    }
    // Sending throws while sm-agent is not running; the state is only tracked once it went out.
    if (!this.announced.has(request.file)) {
      this.send({ kind: 'inform_file_changed', path: request.file })
      this.announced.add(request.file)
    }
    this.post(state)
    this.states.set(state.id, state)
    this.streaming.set(state.key, state)
    this.latest = state
    this.unconfirmed = this.status.connection === 'connected' ? undefined : state
    this.arm(state)
    this.scheduleResend(state, this.options.answerWindowMs)
    return state.reply.promise
  }

  /** The final tokens for `key`; `undefined` if the answer is neither known nor streaming. */
  resume(key: string): Promise<Token[]> | undefined {
    const answer = this.answers.get(key)
    return answer ? Promise.resolve(answer) : this.streaming.get(key)?.final.promise
  }

  private start() {
    this.updateStatus({ connection: 'starting' })
    const child = spawn(this.binary, ['stdio'], {
      cwd: this.workspace,
      env: {
        ...process.env,
        ...(this.options.homeDirectory && { HOME: this.options.homeDirectory }),
        SM_EDITOR: 'vscode',
        SM_EDITOR_VERSION: this.options.editorVersion,
        SM_EXTENSION_VERSION: this.options.extensionVersion,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    const ended = (reason: Error) => {
      if (this.child !== child) return
      this.stop(reason)
      this.updateStatus({ connection: 'exited' })
      this.log.warn(reason.message)
    }
    child.once('error', ended)
    child.once('exit', (code, signal) => ended(new Error(`sm-agent exited with ${signal ?? `code ${code}`}`)))
    // Writing to an agent that just died must not bring down the shared process.
    child.stdin!.on('error', error => this.log.warn(`sm-agent input: ${error.message}`))
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => this.log.warn(chunk.trimEnd()))
    createInterface({ input: child.stdout! }).on('line', line => {
      try {
        this.receive(line)
      } catch (error) {
        this.log.error(error)
      }
    })

    this.send({ kind: 'greeting', allowGitignore: this.options.allowGitignore })
    this.send({ kind: 'auth' })
    // A throwaway state makes sm-agent connect before the first real request arrives.
    this.send({ kind: 'inform_file_changed', path: 'vscursed-warmup' })
    this.send({
      kind: 'state_update',
      newId: 'warmup',
      updates: [
        { kind: 'file_update', path: 'vscursed-warmup', content: '' },
        { kind: 'cursor_update', path: 'vscursed-warmup', offset: 0 },
      ],
    })
    this.log.info(`sm-agent started in ${this.workspace}`)
  }

  private stop(reason: Error) {
    const child = this.child
    this.child = undefined
    child?.kill()
    for (const state of this.states.values()) this.fail(state, reason)
    this.latest = this.unconfirmed = undefined
    this.announced.clear()
    this.answers.clear()
  }

  private receive(line: string) {
    if (!line.startsWith(messagePrefix)) return
    const raw = JSON.parse(line.slice(messagePrefix.length))
    if (messageKinds.has(raw?.kind)) this.handle(MessageSchema.parse(raw))
  }

  private handle(message: Message) {
    switch (message.kind) {
      case 'response':
        return this.respond(String(message.stateId), message.items)
      case 'connection_status': {
        this.updateStatus({ connection: message.is_connected ? 'connected' : 'disconnected' })
        if (!message.is_connected) return
        if (this.unconfirmed) this.post(this.unconfirmed)
        this.unconfirmed = undefined
        // Waiting for a connection is over; what remains is waiting for an answer.
        for (const state of this.states.values()) this.arm(state)
        return
      }
      case 'user_status':
        this.updateStatus({ tier: message.tier ?? null, email: message.email ?? null })
        return
      case 'error':
        this.log.warn(`sm-agent: ${JSON.stringify(message)}`)
    }
  }

  private updateStatus(change: Partial<AgentStatus>) {
    this.status = { ...this.status, ...change }
    this.onStatus(this.status)
  }

  private respond(id: string, items: Token[]) {
    const state = this.states.get(id)
    if (!state) return
    state.tokens = mergeTokens(state.tokens, items)
    clearTimeout(state.resend)
    if (items.some(token => token.kind === 'end' || token.kind === 'finish_edit')) return this.finish(state)
    if (!state.delivered && hasCompleteLine(state.tokens)) {
      state.delivered = true
      clearTimeout(state.deadline)
      state.reply.resolve({ tokens: state.tokens, incomplete: true })
    }
    // Without an end marker, a quiet period ends the answer.
    clearTimeout(state.quiet)
    state.quiet = setTimeout(() => this.finish(state), this.options.responseWindowMs)
  }

  private send(message: object) {
    const input = this.child?.stdin
    if (!input?.writable) throw new Error('sm-agent is not running')
    input.write(`${JSON.stringify(message)}\n`)
  }

  private post(state: State) {
    this.send({ kind: 'state_update', newId: state.id, updates: state.updates })
  }

  /** Sets the deadline of an unanswered state, which is longer while sm-agent is not yet connected. */
  private arm(state: State) {
    if (state.delivered) return
    clearTimeout(state.deadline)
    const timeout =
      this.status.connection === 'connected' ? this.options.requestTimeoutMs : this.options.connectTimeoutMs
    state.deadline = setTimeout(
      () => this.fail(state, new Error(`sm-agent did not answer within ${timeout}ms`)),
      timeout,
    )
  }

  /** Resends a state that has no answer yet, with exponential backoff. */
  private scheduleResend(state: State, delay: number) {
    state.resend = setTimeout(() => {
      if (!this.states.has(state.id) || state.tokens.length) return
      this.post(state)
      this.scheduleResend(state, Math.min(delay * 2, this.options.retryMaxMs))
    }, delay)
  }

  private supersede() {
    const state = this.latest
    if (!state || state.delivered || !this.states.has(state.id)) return
    this.remove(state)
    state.reply.resolve({ tokens: [], incomplete: false })
    state.final.resolve([])
  }

  private finish(state: State) {
    if (!this.states.has(state.id)) return
    this.remove(state)
    if (!state.delivered) state.reply.resolve({ tokens: state.tokens, incomplete: false })
    this.answers.delete(state.key)
    this.answers.set(state.key, state.tokens)
    for (const key of this.answers.keys()) {
      if (this.answers.size <= answerCacheSize) break
      this.answers.delete(key)
    }
    state.final.resolve(state.tokens)
  }

  private fail(state: State, reason: Error) {
    if (!this.states.has(state.id)) return
    this.remove(state)
    state.reply.reject(reason)
    state.final.resolve([])
  }

  private remove(state: State) {
    this.states.delete(state.id)
    if (this.streaming.get(state.key) === state) this.streaming.delete(state.key)
    if (this.latest === state) this.latest = undefined
    if (this.unconfirmed === state) this.unconfirmed = undefined
    clearTimeout(state.deadline)
    clearTimeout(state.resend)
    clearTimeout(state.quiet)
  }
}
