import { describe, expect, it } from 'vite-plus/test'
import { z } from 'zod'
import { configJsonSchema, mergeRealmSchemas } from '../src/kernel/schema.ts'

describe('configJsonSchema', () => {
  it('converts a Standard JSON Schema Config into its input schema', () => {
    const schema = configJsonSchema(z.object({ interval: z.number().min(100).default(1000).describe('Tick') }))
    expect(schema).toEqual({
      type: 'object',
      properties: { interval: { type: 'number', minimum: 100, default: 1000, description: 'Tick' } },
    })
  })

  it('returns nothing for plugins without a convertible Config', () => {
    expect(configJsonSchema(undefined)).toBeUndefined()
    expect(configJsonSchema({ '~standard': { validate: () => ({ value: 1 }) } })).toBeUndefined()
  })
})

describe('mergeRealmSchemas', () => {
  it('merges object schemas key by key', () => {
    const merged = mergeRealmSchemas({
      renderer: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
      sharedProcess: { type: 'object', properties: { interval: { type: 'number' } } },
    })
    expect(merged).toEqual({
      type: 'object',
      properties: { label: { type: 'string' }, interval: { type: 'number' } },
      required: ['label'],
    })
  })

  it('requires every realm for other schemas', () => {
    const merged = mergeRealmSchemas({ renderer: { type: 'string' }, main: { type: 'object' } })
    expect(merged).toEqual({ allOf: [{ type: 'string' }, { type: 'object' }] })
  })

  it('accepts any object when no realm reported a schema', () => {
    expect(mergeRealmSchemas({ renderer: null })).toEqual({ type: 'object' })
  })
})
