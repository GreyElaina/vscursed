import type { Token } from '../protocol.ts'

/** What an answer asks the editor to do at the caret. */
export type Answer =
  | { kind: 'text'; text: string; dedent: string }
  | { kind: 'skip'; lines: number }
  | { kind: 'delete'; lines: string[] }

/**
 * Reads an answer's tokens in order. Text wins once it is more than whitespace; otherwise the answer
 * may skip lines or delete them. A deletion names each line it removes, and holds only while those
 * lines still follow the caret: `following(i)` is the i-th line below it.
 */
export function decodeAnswer(tokens: readonly Token[], following: (index: number) => string): Answer | null {
  let text = ''
  let dedent = ''
  const deleted: string[] = []
  const written = (): Answer | null => (text.trim() ? { kind: 'text', text, dedent } : null)
  for (const token of tokens) {
    if (deleted.length && token.kind !== 'delete') return { kind: 'delete', lines: deleted }
    switch (token.kind) {
      case 'text':
        text += token.text
        break
      case 'dedent':
        dedent += token.text
        break
      case 'delete': {
        const answer = written()
        if (answer) return answer
        if (token.verify.trimEnd() !== following(deleted.length).trimEnd()) return null
        deleted.push(token.verify)
        break
      }
      case 'skip':
        return written() ?? { kind: 'skip', lines: token.n }
      case 'barrier':
      case 'finish_edit':
      case 'end': {
        const answer = written()
        if (answer) return answer
        break
      }
    }
  }
  // Deletions count only when something after them shows that the list is complete.
  return deleted.length ? null : written()
}

/** The acceptable part of answer text: a streaming answer's unfinished last line is left out. */
export function settledText(text: string, streaming: boolean): string {
  const kept = streaming ? text.slice(0, Math.max(text.lastIndexOf('\n'), 0)) : text
  return kept.replace(/\n+$/, '')
}
