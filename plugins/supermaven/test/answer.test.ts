import { describe, expect, it } from 'vite-plus/test'
import type { Token } from '../src/protocol.ts'
import { decodeAnswer, settledText } from '../src/renderer/answer.ts'

const lines =
  (...values: string[]) =>
  (index: number) =>
    values[index] ?? ''

describe('decodeAnswer', () => {
  it('returns text with its dedent once text is more than whitespace', () => {
    const tokens: Token[] = [
      { kind: 'dedent', text: '  ' },
      { kind: 'text', text: '\n' },
      { kind: 'text', text: 'return value\n' },
      { kind: 'barrier' },
      { kind: 'text', text: 'ignored' },
    ]
    expect(decodeAnswer(tokens, lines())).toEqual({ kind: 'text', text: '\nreturn value\n', dedent: '  ' })
  })

  it('skips lines only when no text precedes the skip', () => {
    expect(
      decodeAnswer(
        [
          { kind: 'text', text: ' ' },
          { kind: 'skip', n: 3 },
        ],
        lines(),
      ),
    ).toEqual({
      kind: 'skip',
      lines: 3,
    })
    expect(
      decodeAnswer(
        [
          { kind: 'text', text: 'x' },
          { kind: 'skip', n: 3 },
        ],
        lines(),
      ),
    ).toEqual({
      kind: 'text',
      text: 'x',
      dedent: '',
    })
  })

  it('deletes lines only while every named line still follows the caret', () => {
    const tokens: Token[] = [{ kind: 'delete', verify: 'one  ' }, { kind: 'delete', verify: 'two' }, { kind: 'end' }]
    expect(decodeAnswer(tokens, lines('one', 'two'))).toEqual({ kind: 'delete', lines: ['one  ', 'two'] })
    expect(decodeAnswer(tokens, lines('one', 'changed'))).toBeNull()
  })

  it('ignores a deletion that has not been closed by a later token', () => {
    expect(decodeAnswer([{ kind: 'delete', verify: 'one' }], lines('one'))).toBeNull()
  })

  it('has no answer for whitespace alone', () => {
    expect(decodeAnswer([{ kind: 'text', text: '\n  ' }, { kind: 'end' }], lines())).toBeNull()
  })
})

describe('settledText', () => {
  it('leaves out the unfinished last line of a streaming answer', () => {
    expect(settledText('first\nsecond\nunfinished', true)).toBe('first\nsecond')
    expect(settledText('unfinished', true)).toBe('')
  })

  it('keeps a finished answer without its trailing line breaks', () => {
    expect(settledText('first\nsecond\n\n', false)).toBe('first\nsecond')
  })
})
