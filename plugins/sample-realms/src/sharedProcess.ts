import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import type { Config } from './shared.ts'

export { Config } from './shared.ts'

export const name = 'sample-realms'
export const inject = ['bridge']

export function apply(ctx: Context, config: Config) {
  const listeners = new Set<(now: number) => unknown>()
  ctx.effect(() => {
    const timer = setInterval(() => {
      for (const listener of listeners) listener(Date.now())
    }, config.interval)
    return () => clearInterval(timer)
  }, 'sample.clock timer')
  ctx.bridge.provide('sharedProcess', 'sample.clock', {
    now: () => Date.now(),
    onTick: listener => {
      listeners.add(listener)
      return { dispose: () => void listeners.delete(listener) }
    },
  })
}
