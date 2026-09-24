import { Context, Service } from 'cordis'

declare module 'cordis' {
  interface Context {
    interceptor: Interceptor
  }
}

type AnyFunction = (...args: any[]) => any

/** Keys of `T` whose values are functions. */
export type MethodKey<T> = { [K in keyof T]-?: T[K] extends AnyFunction ? K : never }[keyof T] & PropertyKey

/**
 * One layer around a method. `next` invokes the inner layers (and finally the original method) with the
 * same receiver; a middleware may change the arguments, replace the result, or not call `next` at all.
 */
export type Middleware<T, F extends AnyFunction> = (
  this: T,
  next: (...args: Parameters<F>) => ReturnType<F>,
  ...args: Parameters<F>
) => ReturnType<F>

export interface AroundOptions {
  /** Place this layer outside every layer registered before it. */
  prepend?: boolean
}

interface Layer {
  middleware: AnyFunction
}

/**
 * The trampoline installed on one property. It lives while any layer is registered; afterwards the
 * property's original descriptor is restored, or the own property is deleted if the method was inherited.
 */
class JoinPoint {
  readonly layers: Layer[] = []
  readonly trampoline: AnyFunction
  private readonly target: object
  private readonly key: PropertyKey
  private readonly original: PropertyDescriptor | undefined

  constructor(target: object, key: PropertyKey) {
    this.target = target
    this.key = key
    this.original = Reflect.getOwnPropertyDescriptor(target, key)
    const base = this.resolveBase()
    if (this.original && !('value' in this.original)) {
      throw new TypeError(`cannot intercept accessor property ${String(key)}`)
    }
    if (this.original && !this.original.configurable && !this.original.writable) {
      throw new TypeError(`cannot intercept read-only property ${String(key)}`)
    }
    if (typeof base !== 'function') throw new TypeError(`${String(key)} is not a method`)
    if (!this.original && !Object.isExtensible(target))
      throw new TypeError(`cannot intercept ${String(key)} on a non-extensible object`)

    const joinPoint = this
    const trampoline = function (this: unknown, ...args: unknown[]) {
      // A snapshot keeps an in-flight call stable while layers are added or removed.
      const layers = joinPoint.layers.slice()
      const method = joinPoint.resolveBase()
      const dispatch = (index: number, args: unknown[]): unknown =>
        index < layers.length
          ? Reflect.apply(layers[index]!.middleware, this, [(...next: unknown[]) => dispatch(index + 1, next), ...args])
          : Reflect.apply(method, this, args)
      return dispatch(0, args)
    }
    Object.defineProperty(trampoline, 'name', { value: base.name })
    Object.defineProperty(trampoline, 'length', { value: base.length })
    this.trampoline = trampoline
    Object.defineProperty(target, key, {
      value: trampoline,
      writable: true,
      configurable: true,
      enumerable: this.original?.enumerable ?? false,
    })
  }

  /** The method below all layers: the original own value, or the current inherited one. */
  private resolveBase(): AnyFunction {
    if (this.original) return this.original.value
    return Reflect.get(Object.getPrototypeOf(this.target) ?? {}, this.key)
  }

  /** Whether the trampoline is still the property value, so that restoring it discards nobody's change. */
  get installed() {
    return Reflect.getOwnPropertyDescriptor(this.target, this.key)?.value === this.trampoline
  }

  restore() {
    if (this.original) Object.defineProperty(this.target, this.key, this.original)
    else Reflect.deleteProperty(this.target, this.key)
  }
}

/**
 * Wraps methods of existing objects (VS Code services, their prototypes, editor instances) while keeping
 * the objects themselves. Every plugin may wrap the same method; layers are composed in registration
 * order, each registration is an effect of the registering fiber, and plugins may unload in any order.
 */
export class Interceptor extends Service {
  private readonly joinPoints = new WeakMap<object, Map<PropertyKey, JoinPoint>>()

  constructor(ctx: Context) {
    super(ctx, 'interceptor')
  }

  around<T extends object, K extends MethodKey<T>>(
    target: T,
    key: K,
    middleware: Middleware<T, Extract<T[K], AnyFunction>>,
    options: AroundOptions = {},
  ): () => Promise<void> {
    return this.ctx.effect(
      () => {
        let points = this.joinPoints.get(target)
        if (!points) this.joinPoints.set(target, (points = new Map()))
        let point = points.get(key)
        if (!point) points.set(key, (point = new JoinPoint(target, key)))
        const joinPoint = point
        const layer: Layer = { middleware }
        if (options.prepend) joinPoint.layers.unshift(layer)
        else joinPoint.layers.push(layer)
        return () => {
          joinPoint.layers.splice(joinPoint.layers.indexOf(layer), 1)
          if (joinPoint.layers.length) return
          if (!joinPoint.installed) {
            // Someone replaced the trampoline and may still call it; it stays as a pass-through.
            this.ctx
              .logger('interceptor')
              .warn('%s was replaced while intercepted; leaving a pass-through in place', String(key))
            return
          }
          joinPoint.restore()
          points.delete(key)
        }
      },
      `interceptor.around(${String(key)})`,
    )
  }
}
