import { describe, expect, it } from 'vite-plus/test'
import { hasCompleteLine, mergeTokens } from '../src/sharedProcess/agent.ts'

describe('sm-agent token stream', () => {
  it('replaces repeated text with the latest complete prefix', () => {
    const previous = [{ kind: 'text', text: 'first\nsec' }] as const
    const incoming = [{ kind: 'text', text: 'first\nsecond' }, { kind: 'end' }] as const
    expect(mergeTokens(previous, incoming)).toEqual(incoming)
  })

  it('appends a continuation and preserves control tokens', () => {
    const previous = [
      { kind: 'dedent', text: '  ' },
      { kind: 'text', text: 'first' },
    ] as const
    const incoming = [{ kind: 'text', text: ' second' }] as const
    expect(mergeTokens(previous, incoming)).toEqual([...previous, ...incoming])
  })

  it('recognizes a complete line after leading line breaks', () => {
    expect(hasCompleteLine([{ kind: 'text', text: '\nfirst\nsecond' }])).toBe(true)
    expect(hasCompleteLine([{ kind: 'text', text: '\nfirst' }])).toBe(false)
  })
})
