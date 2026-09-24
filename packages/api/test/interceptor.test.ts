import { Context } from 'cordis'
import { beforeEach, describe, expect, it } from 'vite-plus/test'
import { Interceptor } from '../src/interceptor.ts'

class Greeter {
  constructor(public name: string) {}
  greet(greeting: string) {
    return `${greeting}, ${this.name}`
  }
}

/** A plugin that wraps `target[key]` with a layer that tags the result. */
function tagger(target: any, key: string, tag: string, options = {}) {
  return {
    inject: ['interceptor'],
    apply(ctx: Context) {
      ctx.interceptor.around(target, key, (next: any, ...args: any[]) => `${tag}(${next(...args)})`, options)
    },
  }
}

describe('Interceptor', () => {
  let root: Context

  beforeEach(async () => {
    root = new Context()
    await root.plugin(Interceptor)
  })

  it('composes layers in registration order and passes the receiver through', async () => {
    const greeter = new Greeter('Ada')
    await root.plugin(tagger(greeter, 'greet', 'a'))
    await root.plugin(tagger(greeter, 'greet', 'b'))
    expect(greeter.greet('Hi')).toBe('a(b(Hi, Ada))')
    const detached = greeter.greet
    expect(detached.call(new Greeter('Bob'), 'Yo')).toBe('a(b(Yo, Bob))')
  })

  it('places prepended layers outside', async () => {
    const greeter = new Greeter('Ada')
    await root.plugin(tagger(greeter, 'greet', 'a'))
    await root.plugin(tagger(greeter, 'greet', 'b', { prepend: true }))
    expect(greeter.greet('Hi')).toBe('b(a(Hi, Ada))')
  })

  it('lets layers change arguments, replace results and skip the original', async () => {
    const greeter = new Greeter('Ada')
    await root.plugin({
      inject: ['interceptor'],
      apply(ctx: Context) {
        ctx.interceptor.around(greeter, 'greet', function (next, greeting) {
          return greeting === 'skip' ? `skipped by ${this.name}` : next(greeting.toUpperCase())
        })
      },
    })
    expect(greeter.greet('hi')).toBe('HI, Ada')
    expect(greeter.greet('skip')).toBe('skipped by Ada')
  })

  it('unloads layers in any order and restores the original descriptor', async () => {
    const target = { greet: (name: string) => `hello ${name}` }
    const original = Object.getOwnPropertyDescriptor(target, 'greet')
    const a = root.plugin(tagger(target, 'greet', 'a'))
    const b = root.plugin(tagger(target, 'greet', 'b'))
    const c = root.plugin(tagger(target, 'greet', 'c'))
    await Promise.all([a, b, c])
    await b.dispose()
    expect(target.greet('x')).toBe('a(c(hello x))')
    await a.dispose()
    expect(target.greet('x')).toBe('c(hello x)')
    const d = root.plugin(tagger(target, 'greet', 'd'))
    await d
    expect(target.greet('x')).toBe('c(d(hello x))')
    await c.dispose()
    await d.dispose()
    expect(Object.getOwnPropertyDescriptor(target, 'greet')).toEqual(original)
  })

  it('wraps inherited methods with an own property and removes it afterwards', async () => {
    const greeter = new Greeter('Ada')
    const plugin = root.plugin(tagger(greeter, 'greet', 'own'))
    await plugin
    expect(Object.hasOwn(greeter, 'greet')).toBe(true)
    expect(new Greeter('Bob').greet('Hi')).toBe('Hi, Bob')
    await plugin.dispose()
    expect(Object.hasOwn(greeter, 'greet')).toBe(false)
    expect(greeter.greet('Hi')).toBe('Hi, Ada')
  })

  it('composes a prototype layer beneath an instance layer', async () => {
    const greeter = new Greeter('Ada')
    const instance = root.plugin(tagger(greeter, 'greet', 'instance'))
    const prototype = root.plugin(tagger(Greeter.prototype, 'greet', 'prototype'))
    await Promise.all([instance, prototype])
    expect(greeter.greet('Hi')).toBe('instance(prototype(Hi, Ada))')
    await prototype.dispose()
    expect(greeter.greet('Hi')).toBe('instance(Hi, Ada)')
    await instance.dispose()
    expect(Greeter.prototype.greet).toBe(Object.getOwnPropertyDescriptor(Greeter.prototype, 'greet')!.value)
  })

  it('keeps a pass-through when someone replaced the trampoline', async () => {
    const target = { greet: (name: string) => `hello ${name}` }
    const plugin = root.plugin(tagger(target, 'greet', 'a'))
    await plugin
    const trampoline = target.greet
    target.greet = name => `outer ${trampoline(name)}`
    await plugin.dispose()
    expect(target.greet('x')).toBe('outer hello x')
  })

  it('rejects properties it cannot wrap', async () => {
    const accessor = {
      get method() {
        return () => 1
      },
    }
    const frozen = Object.freeze({ method: () => 1 })
    const fiber = root.plugin({
      inject: ['interceptor'],
      apply(ctx: Context) {
        expect(() => ctx.interceptor.around(accessor, 'method', next => next())).toThrow(/accessor/)
        expect(() => ctx.interceptor.around(frozen, 'method', next => next())).toThrow(/read-only/)
      },
    })
    await fiber
  })
})
