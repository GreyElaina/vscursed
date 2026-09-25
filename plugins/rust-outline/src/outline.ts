import type { Context } from 'cordis'
import type { Event } from 'vscode-internal/vs/base/common/event.js'
import type { DisposableStore, IDisposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import type { URI } from 'vscode-internal/vs/base/common/uri.js'
import type { DocumentSymbol } from 'vscode-internal/vs/editor/common/languages.js'
import type {
  OutlineElement,
  OutlineGroup,
  TreeElement,
} from 'vscode-internal/vs/editor/contrib/documentSymbols/browser/outlineModel.js'
import type { IEditorOptions } from 'vscode-internal/vs/platform/editor/common/editor.js'
import type {
  IOutline,
  IOutlineListConfig,
  OutlineChangeEvent,
} from 'vscode-internal/vs/workbench/services/outline/browser/outline.js'
import {
  projectRustOutline,
  type DocumentSymbol as SourceSymbol,
  type ProjectionNode,
  type ProjectionOptions,
} from './projection.ts'

/** The items of VS Code's document symbols outline. */
type Entry = OutlineElement | OutlineGroup

type OutlineElementClass = new (id: string, parent: TreeElement | undefined, symbol: DocumentSymbol) => OutlineElement

/** `OutlineElement` is not importable, so elements are told apart from groups by shape. */
const isElement = (entry: TreeElement): entry is OutlineElement => 'symbol' in entry

declare module 'cordis' {
  interface Events {
    'rust-outline/change'(outline: ProjectedOutline, event: OutlineChangeEvent): void
  }
}

interface Projection {
  readonly roots: OutlineElement[]
  /** The projected element that stands for each native symbol, for tracking the active element. */
  readonly bySymbol: Map<SourceSymbol, OutlineElement>
}

/**
 * Decorates VS Code's document symbols outline with the Rust projection. Only the tree content changes;
 * renderers, filter, comparator, reveal, preview and view state stay native, and they accept the projected
 * items because these are real `OutlineElement`s. Documents that are not Rust pass through unchanged, which
 * is decided on every native update: the native outline exists before a symbol provider has loaded the
 * document, and may change its language later.
 */
export class ProjectedOutline implements IOutline<Entry> {
  readonly config: IOutlineListConfig<Entry>
  /** Subscriptions are Cordis listeners of the plugin, so they end when it unloads. */
  readonly onDidChange: Event<OutlineChangeEvent> = (
    listener,
    thisArgs?,
    disposables?: IDisposable[] | DisposableStore,
  ) => {
    const dispose = this.ctx.on('rust-outline/change', (outline, event) => {
      if (outline === this) listener.call(thisArgs, event)
    })
    const subscription = { dispose: () => void dispose() }
    if (Array.isArray(disposables)) disposables.push(subscription)
    else disposables?.add(subscription)
    return subscription
  }
  readonly #sourceListener: IDisposable
  #projection: Projection | undefined

  constructor(
    private readonly ctx: Context,
    private readonly source: IOutline<Entry>,
    private readonly options: ProjectionOptions,
    private readonly isRust: (uri: URI) => boolean,
  ) {
    const native = source.config.treeDataSource
    this.config = {
      ...source.config,
      treeDataSource: {
        getChildren: parent => {
          if (!this.#projection) return native.getChildren(parent === this ? source : parent)
          return parent === this ? this.#projection.roots : (parent as Entry).children.values()
        },
      },
    }
    this.#projection = this.#project()
    this.#sourceListener = source.onDidChange(event => {
      // Cursor moves leave the native model alone; keeping the projected elements keeps them in the tree.
      if (!event.affectOnlyActiveElement) this.#projection = this.#project()
      this.ctx.emit('rust-outline/change', this, event)
    })
  }

  get uri() {
    return this.source.uri
  }

  get outlineKind() {
    return this.source.outlineKind
  }

  get isEmpty(): boolean {
    return this.#projection ? this.#projection.roots.length === 0 : this.source.isEmpty
  }

  get activeElement(): Entry | undefined {
    const active = this.source.activeElement
    if (!this.#projection) return active
    for (let entry: TreeElement | undefined = active; entry && isElement(entry); entry = entry.parent) {
      const projected = this.#projection.bySymbol.get(entry.symbol)
      if (projected) return projected
    }
    return undefined
  }

  reveal(entry: Entry, options: IEditorOptions, sideBySide: boolean, select: boolean): Promise<void> | void {
    return this.source.reveal(entry, options, sideBySide, select)
  }

  preview(entry: Entry): IDisposable {
    return this.source.preview(entry)
  }

  captureViewState(): IDisposable {
    return this.source.captureViewState()
  }

  dispose(): void {
    this.#sourceListener.dispose()
    this.source.dispose()
  }

  #project(): Projection | undefined {
    const { uri } = this.source
    if (!uri || !this.isRust(uri)) return undefined
    // The native roots are elements, or groups of elements when several symbol providers contribute.
    const sources = [...this.source.config.treeDataSource.getChildren(this.source)].flatMap(entry =>
      isElement(entry) ? [entry] : [...entry.children.values()],
    )
    if (sources.length === 0) return undefined

    const Element = sources[0]!.constructor as OutlineElementClass
    const markers = new Map<SourceSymbol, OutlineElement['marker']>()
    const collectMarkers = (element: OutlineElement) => {
      markers.set(element.symbol, element.marker)
      element.children.forEach(collectMarkers)
    }
    sources.forEach(collectMarkers)

    const bySymbol = new Map<SourceSymbol, OutlineElement>()
    const create = (nodes: readonly ProjectionNode[], parent: TreeElement): OutlineElement[] => {
      const ids = new Set<string>()
      return nodes.map(node => {
        const { symbol } = node
        // Unique among the siblings created here, in the manner of `TreeElement.findId`.
        const named = `${parent.id}/${symbol.name}`
        const candidate = ids.has(named)
          ? `${named}_${symbol.range.startLineNumber}_${symbol.range.startColumn}`
          : named
        let id = candidate
        for (let index = 0; ids.has(id); index++) id = `${candidate}_${index}`
        ids.add(id)

        const element = new Element(id, parent, { ...symbol, detail: symbol.detail ?? '', tags: symbol.tags ?? [] })
        element.marker = node.activeSources[0] && markers.get(node.activeSources[0])
        for (const source of node.activeSources) bySymbol.set(source, element)
        for (const child of create(node.children, element)) element.children.set(child.id, child)
        return element
      })
    }
    // Like native roots, projected roots hang below the native outline model.
    let model: TreeElement = sources[0]!
    while (model.parent) model = model.parent
    const symbols = sources.map(element => element.symbol)
    return { roots: create(projectRustOutline(symbols, this.options), model), bySymbol }
  }
}
