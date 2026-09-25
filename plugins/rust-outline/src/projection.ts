/**
 * The Rust outline as a pure function of the document symbols rust-analyzer reports: `impl` blocks move
 * under the type they implement, trait impls are named by their trait, and function bodies can be hidden.
 */

export interface SymbolRange {
  readonly startLineNumber: number
  readonly startColumn: number
  readonly endLineNumber: number
  readonly endColumn: number
}

/** A document symbol as the projection reads it; VS Code's `DocumentSymbol` satisfies it. */
export interface DocumentSymbol {
  readonly name: string
  readonly detail?: string
  readonly kind: number
  readonly tags?: readonly number[]
  readonly range: SymbolRange
  readonly selectionRange: SymbolRange
  readonly children?: readonly DocumentSymbol[]
}

export type ProjectedSymbol = Omit<DocumentSymbol, 'children'>

export interface ProjectionOptions {
  readonly bodyItems: 'hide' | 'show'
  readonly boilerplateTraits: readonly string[]
  readonly detail: 'full' | 'params' | 'return' | 'none'
  readonly groupBoilerplate: boolean
  readonly groupImpls: boolean
  readonly inherentMode: 'inline' | 'group'
  readonly orphans: 'group' | 'keep'
  readonly traitImplOrder: 'name' | 'position'
  readonly labels: {
    readonly boilerplate: string
    readonly otherImpl: string
  }
}

export interface ProjectionNode {
  readonly symbol: ProjectedSymbol
  readonly children: readonly ProjectionNode[]
  /** Source symbols whose position makes this node the active one, e.g. a type and its inlined impls. */
  readonly activeSources: readonly DocumentSymbol[]
}

const SymbolKind = {
  Class: 4,
  Method: 5,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Object: 18,
  Struct: 22,
  TypeParameter: 25,
} as const

const typeKinds = new Set<number>([
  SymbolKind.Class,
  SymbolKind.Enum,
  SymbolKind.Interface,
  SymbolKind.Struct,
  SymbolKind.TypeParameter,
])

/** rust-analyzer reports `impl` blocks as objects. */
const isImpl = (symbol: DocumentSymbol) => symbol.kind === SymbolKind.Object
const isType = (symbol: DocumentSymbol) => typeKinds.has(symbol.kind)
const isCallable = (symbol: DocumentSymbol) => symbol.kind === SymbolKind.Function || symbol.kind === SymbolKind.Method

interface TraitImpl {
  readonly symbol: DocumentSymbol
  /** The trait's last path segment without generic arguments (`Display`, `!Send`); `''` if unreadable. */
  readonly trait: string
}

/** The impls attached to one declared type, in document order. */
interface OwnedImpls {
  readonly inherent: DocumentSymbol[]
  readonly traits: TraitImpl[]
}

/** Splits `impl Type` / `impl Trait for Type`; `undefined` for any other label. */
function parseImpl(label: string): { readonly trait: string | null; readonly selfType: string } | undefined {
  if (!label.startsWith('impl ')) return undefined
  const body = label.slice('impl '.length).trim()
  const separator = body.lastIndexOf(' for ')
  if (separator === -1) return { trait: null, selfType: body }
  return { trait: body.slice(0, separator).trim(), selfType: body.slice(separator + ' for '.length).trim() }
}

/** `&'a mut path::Type<T>` → `Type`; `null` when the type is not a plain path (tuples, slices, …). */
function baseTypeName(type: string): string | null {
  const head = type
    .trim()
    .replace(/^&+\s*/, '')
    .replace(/^'[A-Za-z_][A-Za-z0-9_]*\s*/, '')
    .replace(/^mut\s+/, '')
    .split(/[<(]/u)[0]!
  const segment = head.split('::').at(-1)!.trim()
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment) ? segment : null
}

function traitShortName(trait: string): string {
  const negation = trait.startsWith('!') ? '!' : ''
  const segment = trait.slice(negation.length).split('::').at(-1)!.split('<')[0]!.trim()
  return segment && negation + segment
}

/** Splits at commas outside brackets; the `>` of `->` closes nothing. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index <= text.length; index++) {
    const character = text[index]
    if (character === '<' || character === '(' || character === '[') depth++
    else if ((character === '>' && text[index - 1] !== '-') || character === ')' || character === ']')
      depth = Math.max(0, depth - 1)
    else if ((character === ',' && depth === 0) || character === undefined) {
      const part = text.slice(start, index).trim()
      if (part) parts.push(part)
      start = index + 1
    }
  }
  return parts
}

/** Reads from the opening bracket at `start` to its match; returns the inner text and the index after it. */
function readBalanced(text: string, start: number, open: string, close: string): readonly [string, number] {
  let depth = 0
  for (let index = start; index < text.length; index++) {
    if (text[index] === open) depth++
    else if (text[index] === close && !(close === '>' && text[index - 1] === '-') && --depth === 0)
      return [text.slice(start + 1, index), index + 1]
  }
  return [text.slice(start + 1), text.length]
}

/** Collapses whitespace, tightens `< >`, and spaces `,` and `->` uniformly. */
function normalizeType(text: string): string {
  return text
    .split('->')
    .map(part =>
      part
        .replace(/<\s+/gu, '<')
        .replace(/\s+>/gu, '>')
        .replace(/\s*,\s*/gu, ', '),
    )
    .join(' -> ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** `fn<T>(params) -> R` → its parameter list and return type; `undefined` for any other detail. */
function parseSignature(detail: string): { readonly parameters: string; readonly returns?: string } | undefined {
  if (!detail.startsWith('fn')) return undefined
  let index = 'fn'.length
  if (detail[index] === '<') index = readBalanced(detail, index, '<', '>')[1]
  if (detail[index] !== '(') return undefined
  const [parameters, end] = readBalanced(detail, index, '(', ')')
  const rest = detail.slice(end).trim()
  return rest.startsWith('->') ? { parameters, returns: normalizeType(rest.slice(2)) } : { parameters }
}

function parameterName(parameter: string): string {
  if (/^(?:&\s*(?:'\w+\s*)?(?:mut\s+)?)?self$/u.test(parameter)) return 'self'
  const separator = parameter.indexOf(':')
  return (separator === -1 ? parameter : parameter.slice(0, separator)).replace(/^\s*mut\s+/u, '').trim()
}

function compactDetail(symbol: DocumentSymbol, mode: ProjectionOptions['detail']): string | undefined {
  const { detail } = symbol
  if (detail === undefined || mode === 'none') return undefined
  const signature = isCallable(symbol) ? parseSignature(detail) : undefined
  if (!signature || mode === 'full') return normalizeType(detail)
  if (mode === 'return') return signature.returns === undefined ? undefined : `-> ${signature.returns}`
  const names = splitTopLevel(signature.parameters).map(parameterName).filter(Boolean)
  const parameters = `(${names.join(', ')})`
  return signature.returns === undefined ? parameters : `${parameters} -> ${signature.returns}`
}

function copy(
  { children: _children, ...symbol }: DocumentSymbol,
  overrides: Pick<ProjectedSymbol, 'name' | 'detail'> | Pick<ProjectedSymbol, 'detail'>,
): ProjectedSymbol {
  return { ...symbol, ...overrides }
}

export function projectRustOutline(
  symbols: readonly DocumentSymbol[],
  options: ProjectionOptions,
): readonly ProjectionNode[] {
  const hideBodies = options.bodyItems === 'hide'
  const withDetail = (symbol: DocumentSymbol) => copy(symbol, { detail: compactDetail(symbol, options.detail) })

  if (!options.groupImpls) {
    const plain = (symbol: DocumentSymbol, inBody: boolean): ProjectionNode => {
      const body = inBody || isCallable(symbol)
      return {
        symbol: withDetail(symbol),
        children: body && hideBodies ? [] : (symbol.children ?? []).map(child => plain(child, body)),
        activeSources: [symbol],
      }
    }
    return symbols.map(symbol => plain(symbol, false))
  }

  // Types by base name, first declaration wins; declarations nested in a type are not owners.
  const declarations = new Map<string, DocumentSymbol>()
  const declare = (items: readonly DocumentSymbol[]) => {
    for (const symbol of items) {
      if (isImpl(symbol)) continue
      if (!isType(symbol)) declare(symbol.children ?? [])
      else {
        const name = baseTypeName(symbol.name)
        if (name !== null && !declarations.has(name)) declarations.set(name, symbol)
      }
    }
  }
  declare(symbols)

  const owned = new Map<DocumentSymbol, OwnedImpls>()
  const orphans: DocumentSymbol[] = []
  const attach = (items: readonly DocumentSymbol[]) => {
    for (const symbol of items) {
      if (!isImpl(symbol)) {
        attach(symbol.children ?? [])
        continue
      }
      const parsed = parseImpl(symbol.name)
      const ownerName = parsed && baseTypeName(parsed.selfType)
      const owner = ownerName ? declarations.get(ownerName) : undefined
      if (!parsed || !owner) {
        orphans.push(symbol)
        continue
      }
      let impls = owned.get(owner)
      if (!impls) owned.set(owner, (impls = { inherent: [], traits: [] }))
      if (parsed.trait === null) impls.inherent.push(symbol)
      else impls.traits.push({ symbol, trait: traitShortName(parsed.trait) })
    }
  }
  attach(symbols)

  const member = (symbol: DocumentSymbol, inBody = false): ProjectionNode => {
    const body = inBody || isCallable(symbol)
    return {
      symbol: withDetail(symbol),
      children:
        body && hideBodies
          ? []
          : (symbol.children ?? [])
              .filter(child => !isImpl(child))
              .map(child => (!body && isType(child) ? type(child) : member(child, body))),
      activeSources: [symbol],
    }
  }

  const implGroup = (impl: DocumentSymbol, name: string): ProjectionNode => ({
    symbol: copy(impl, { name, detail: undefined }),
    children: (impl.children ?? []).map(child => member(child)),
    activeSources: [impl],
  })

  /** A synthetic folder, positioned at `anchor`, that is never the active element itself. */
  const folder = (name: string, anchor: DocumentSymbol, children: ProjectionNode[]): ProjectionNode => ({
    symbol: copy(anchor, { name, detail: undefined }),
    children,
    activeSources: [],
  })

  const boilerplate = new Set(options.boilerplateTraits.map(trait => trait.toLowerCase()))
  const isBoilerplate = (impl: TraitImpl) => options.groupBoilerplate && boilerplate.has(impl.trait.toLowerCase())
  const traitGroup = (impl: TraitImpl) => implGroup(impl.symbol, impl.trait || impl.symbol.name)

  const type = (symbol: DocumentSymbol): ProjectionNode => {
    const children = (symbol.children ?? []).filter(child => !isImpl(child)).map(child => member(child))
    const activeSources = [symbol]
    const { inherent, traits } = owned.get(symbol) ?? { inherent: [], traits: [] }
    for (const impl of inherent) {
      if (options.inherentMode === 'group') children.push(implGroup(impl, 'impl'))
      else {
        activeSources.push(impl)
        children.push(...(impl.children ?? []).map(child => member(child)))
      }
    }
    const ordered =
      options.traitImplOrder === 'name' ? traits.toSorted((a, b) => a.trait.localeCompare(b.trait)) : traits
    const folded = ordered.filter(isBoilerplate)
    children.push(...ordered.filter(impl => !isBoilerplate(impl)).map(traitGroup))
    if (folded.length > 1)
      children.push(
        folder(`${options.labels.boilerplate} (${folded.length})`, folded[0]!.symbol, folded.map(traitGroup)),
      )
    else children.push(...folded.map(traitGroup))
    return { symbol: withDetail(symbol), children, activeSources }
  }

  const roots = symbols
    .filter(symbol => !isImpl(symbol))
    .map(symbol => (isType(symbol) ? type(symbol) : member(symbol)))
  const orphanGroups = orphans.map(impl => implGroup(impl, impl.name))
  if (options.orphans === 'group' && orphans.length > 0)
    roots.push(folder(`${options.labels.otherImpl} (${orphans.length})`, orphans[0]!, orphanGroups))
  else roots.push(...orphanGroups)
  return roots
}
