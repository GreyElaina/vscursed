import type { Remote } from '@vscursed/api'
import type { Context } from 'cordis'
import type { CancellationToken } from 'vscode-internal/vs/base/common/cancellation.js'
import type { Position } from 'vscode-internal/vs/editor/common/core/position.js'
import {
  InlineCompletionEndOfLifeReasonKind,
  type InlineCompletion,
  type InlineCompletionContext,
  type InlineCompletionEndOfLifeReason,
  type InlineCompletions,
  type InlineCompletionsProvider,
} from 'vscode-internal/vs/editor/common/languages.js'
import type { ITextModel } from 'vscode-internal/vs/editor/common/model.js'
import type { Config } from '../config.ts'
import type { SupermavenChannel } from '../protocol.ts'
import { decodeAnswer } from './answer.ts'
import { DocumentSession, type Edit } from './session.ts'

/** What accepting one of the provider's items means. */
export type Acceptance = { model: ITextModel } & (
  | { kind: 'text'; key: string }
  /** A skip or delete answer, offered as a marker that the acceptance removes again before acting. */
  | { kind: 'skip'; marker: string; lines: number }
  | { kind: 'delete'; marker: string; lines: string[] }
)

declare module 'cordis' {
  interface Events {
    /** The provider's requests in flight or a held answer changed. */
    'supermaven/change'(): void
    /** VS Code inserted one of the provider's items. */
    'supermaven/accept'(acceptance: Acceptance): void
  }
}

export interface DocumentLocation {
  workspace: string
  file: string
}

/** Least time between requests while completions are hidden. */
const backgroundInterval = 250

/**
 * The inline completion provider. It keeps one answer per document and hands it out line by line as
 * the user types into it. While completions are hidden (subtle mode) it still fetches answers, so that
 * revealing them is instant.
 */
export class SupermavenCompletions implements InlineCompletionsProvider {
  readonly displayName = 'Supermaven'
  revealed: boolean
  /** Requests in flight. */
  pending = 0
  answeredAt: number | undefined
  private sessions = new WeakMap<ITextModel, DocumentSession>()
  private lastRequest = new WeakMap<ITextModel, number>()
  private readonly acceptances = new WeakMap<InlineCompletion, Acceptance>()

  constructor(
    private readonly ctx: Context,
    private readonly channel: Remote<SupermavenChannel>,
    private readonly config: Config,
    private readonly locate: (model: ITextModel) => DocumentLocation | undefined,
  ) {
    this.revealed = config.mode === 'eager'
  }

  session(model: ITextModel): DocumentSession {
    let session = this.sessions.get(model)
    if (!session) this.sessions.set(model, (session = new DocumentSession(model)))
    return session
  }

  /** Forgets every answer, such as after sm-agent restarted. */
  reset() {
    this.sessions = new WeakMap()
    this.lastRequest = new WeakMap()
    this.answeredAt = undefined
    this.changed()
  }

  async provideInlineCompletions(
    model: ITextModel,
    position: Position,
    context: InlineCompletionContext,
    token: CancellationToken,
  ): Promise<InlineCompletions | undefined> {
    if (!this.config.trigger.enabled || !context.includeInlineCompletions) return
    const session = this.session(model)
    const ready = session.read(position)
    if (ready) return this.revealed ? this.textItem(model, session, ready) : undefined
    if (
      this.config.trigger.requireLineEnd &&
      model
        .getLineContent(position.lineNumber)
        .slice(position.column - 1)
        .trim()
    )
      return
    const location = this.locate(model)
    if (!location) return
    const now = Date.now()
    if (!this.revealed) {
      if (now - (this.lastRequest.get(model) ?? 0) < backgroundInterval) return
      this.lastRequest.set(model, now)
      // Nobody awaits a background request, so its failure is logged here.
      this.request(model, position, location, token).catch(error => this.ctx.logger('supermaven').warn(error))
      return
    }
    this.lastRequest.set(model, now)
    return this.request(model, position, location, token)
  }

  handleEndOfLifetime(
    _completions: InlineCompletions,
    item: InlineCompletion,
    reason: InlineCompletionEndOfLifeReason,
  ) {
    const acceptance = this.acceptances.get(item)
    if (acceptance && reason.kind === InlineCompletionEndOfLifeReasonKind.Accepted) {
      this.ctx.emit('supermaven/accept', acceptance)
    }
  }

  disposeInlineCompletions() {}

  /** A line of the answer with `key` was inserted: move past it and fetch the rest of the answer. */
  async accepted(model: ITextModel, key: string) {
    const session = this.session(model)
    const held = session.prediction
    if (held?.key !== key) return
    session.accepted(key)
    const tokens = await this.channel.resume(held.workspace, key)
    const answer = tokens && decodeAnswer(tokens, () => '')
    if (answer?.kind === 'text') session.refill(key, answer.text, answer.dedent)
    this.changed()
  }

  private changed() {
    this.ctx.emit('supermaven/change')
  }

  private offer(insertText: string, range: InlineCompletion['range'], acceptance: Acceptance): InlineCompletions {
    const item: InlineCompletion = { insertText, range }
    this.acceptances.set(item, acceptance)
    return { items: [item] }
  }

  private textItem(model: ITextModel, session: DocumentSession, edit: Edit): InlineCompletions | undefined {
    const key = session.prediction?.key
    // Ghost text cannot start below a blank line; the view marks such a line and ⌥⇥ inserts it.
    if (!key || edit.onNewLine) return
    return this.offer(edit.insertText, edit.range, { model, kind: 'text', key })
  }

  private async request(
    model: ITextModel,
    position: Position,
    { workspace, file }: DocumentLocation,
    token: CancellationToken,
  ): Promise<InlineCompletions | undefined> {
    const session = this.session(model)
    const ticket = session.issue()
    const content = model.getValue()
    const anchor = model.getOffsetAt(position)
    const prefix = content.slice(0, anchor)
    const version = model.getVersionId()
    const key = `${model.uri.toString()}@${version}:${anchor}`
    const shown = this.revealed
    this.pending++
    this.changed()
    try {
      const reply = await this.channel.complete({
        workspace,
        file,
        content,
        byteOffset: new TextEncoder().encode(prefix).length,
        key,
      })
      if (!session.isCurrent(ticket) || (shown && token.isCancellationRequested)) return
      const answer = decodeAnswer(reply.tokens, index => {
        const line = position.lineNumber + 1 + index
        return line > model.getLineCount() ? '' : model.getLineContent(line)
      })
      if (!answer) return
      if (answer.kind === 'text') {
        const prediction = { anchor, prefix, text: answer.text, dedent: answer.dedent, key, workspace, file }
        session.hold(ticket, prediction, reply.incomplete)
        this.answeredAt = Date.now()
        const edit = session.read(position)
        return shown && this.revealed && edit ? this.textItem(model, session, edit) : undefined
      }
      if (model.getVersionId() !== version || !shown || !this.revealed) return
      session.clear()
      const marker = answer.kind === 'skip' ? ` ↓ ${answer.lines}` : ` ⌦ ${answer.lines.length}`
      const caret = { startLineNumber: position.lineNumber, startColumn: position.column }
      return this.offer(
        marker,
        { ...caret, endLineNumber: position.lineNumber, endColumn: position.column },
        { model, marker, ...answer },
      )
    } finally {
      this.pending--
      this.changed()
    }
  }
}
