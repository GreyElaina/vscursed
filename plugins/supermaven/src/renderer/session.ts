import type { IPosition } from 'vscode-internal/vs/editor/common/core/position.js'
import type { IRange } from 'vscode-internal/vs/editor/common/core/range.js'
import type { ITextModel } from 'vscode-internal/vs/editor/common/model.js'
import { settledText } from './answer.ts'

export type DocumentText = Pick<ITextModel, 'getValue' | 'getValueInRange' | 'getOffsetAt' | 'getLineContent'>

/** An answer kept for a document. It applies while the text before `anchor` is still `prefix`. */
export interface Prediction {
  readonly anchor: number
  readonly prefix: string
  /** Everything the answer inserts from `anchor` on; the user may have typed into it since. */
  readonly text: string
  /** Indentation before the caret that the first line replaces. */
  readonly dedent: string
  readonly key: string
  readonly workspace: string
  readonly file: string
}

/** The next line of a prediction, as an edit at the caret. */
export interface Edit {
  readonly range: IRange
  readonly insertText: string
  /** The line goes below a blank caret line, which ghost text cannot show. */
  readonly onNewLine: boolean
}

/**
 * Finds where the caret is within a prediction and hands out the line that follows. `beforeCaret` is
 * the document up to the caret; `lineBefore` and `lineAfter` split the caret's line.
 */
export function continuation(
  held: Prediction,
  beforeCaret: string,
  position: IPosition,
  lineBefore: string,
  lineAfter: string,
): Edit | null {
  if (beforeCaret.length < held.anchor || !beforeCaret.startsWith(held.prefix)) return null
  const typed = beforeCaret.slice(held.anchor).replaceAll('\r\n', '\n')
  if (!held.text.startsWith(typed)) return null
  const rest = held.text.slice(typed.length)
  if (!rest || !rest.startsWith(lineAfter) || !lineBefore.endsWith(held.dedent)) return null
  // A line break that opens the rest belongs to the line it introduces.
  const end = rest.indexOf('\n', rest.startsWith('\n') ? 1 : 0)
  const insertText = end < 0 ? rest : rest.slice(0, end)
  return {
    range: {
      startLineNumber: position.lineNumber,
      startColumn: position.column - held.dedent.length,
      endLineNumber: position.lineNumber,
      endColumn: position.column + lineAfter.length,
    },
    insertText,
    onNewLine: insertText.startsWith('\n') && !(lineBefore + lineAfter).trim(),
  }
}

/**
 * Completion state of one document. Every request takes a ticket, and only the answer to the latest
 * ticket is kept, so a slow answer never replaces a newer one.
 */
export class DocumentSession {
  prediction: Prediction | undefined
  private ticket = 0
  /** The dedent was applied by accepting the first line; the rest of the answer keeps none. */
  private dedented = false

  constructor(private readonly document: DocumentText) {}

  issue() {
    return ++this.ticket
  }

  isCurrent(ticket: number) {
    return ticket === this.ticket
  }

  clear() {
    this.prediction = undefined
  }

  hold(ticket: number, prediction: Prediction, streaming: boolean) {
    if (!this.isCurrent(ticket)) return
    const text = settledText(prediction.text, streaming)
    this.prediction = text ? { ...prediction, text } : undefined
    this.dedented = false
  }

  /** VS Code inserted the first line of the prediction with `key`, replacing its dedent. */
  accepted(key: string) {
    const held = this.prediction
    if (held?.key !== key || !held.dedent) return
    const anchor = held.anchor - held.dedent.length
    if (anchor < 0) throw new Error('Supermaven dedent reaches before the start of the document')
    this.prediction = { ...held, anchor, prefix: this.document.getValue().slice(0, anchor), dedent: '' }
    this.dedented = true
  }

  /** The complete answer for `key` arrived; it continues the text held so far. */
  refill(key: string, text: string, dedent: string) {
    const held = this.prediction
    if (held?.key !== key) return
    const settled = settledText(text, false)
    this.prediction = settled ? { ...held, text: settled, dedent: this.dedented ? '' : dedent } : undefined
  }

  read(position: IPosition): Edit | null {
    const held = this.prediction
    if (!held || this.document.getOffsetAt(position) < held.anchor) return null
    const beforeCaret = this.document.getValueInRange({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    })
    const line = this.document.getLineContent(position.lineNumber)
    return continuation(
      held,
      beforeCaret,
      position,
      line.slice(0, position.column - 1),
      line.slice(position.column - 1),
    )
  }
}
