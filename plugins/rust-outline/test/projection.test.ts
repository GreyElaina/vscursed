import { describe, expect, it } from 'vite-plus/test'
import {
  type DocumentSymbol,
  type ProjectionNode,
  type ProjectionOptions,
  projectRustOutline,
} from '../src/projection.ts'

const Kind = { Method: 5, Field: 7, Function: 11, Variable: 12, Object: 18, Struct: 22 } as const

function symbol(name: string, kind: number, line: number, children: DocumentSymbol[] = [], detail?: string) {
  const range = { startLineNumber: line, startColumn: 1, endLineNumber: line + 1, endColumn: 1 }
  return { name, kind, detail, range, selectionRange: range, children } satisfies DocumentSymbol
}

const defaults: ProjectionOptions = {
  bodyItems: 'hide',
  boilerplateTraits: ['Debug', 'Clone'],
  detail: 'params',
  groupBoilerplate: true,
  groupImpls: true,
  inherentMode: 'inline',
  orphans: 'group',
  traitImplOrder: 'name',
  labels: { boilerplate: 'Boilerplate', otherImpl: 'Other impls' },
}

/** Names as a nested list: a leaf is its name, an inner node is `[name, children]`. */
type Shape = string | [string, Shape[]]
const shape = (nodes: readonly ProjectionNode[]): Shape[] =>
  nodes.map(node => (node.children.length ? [node.symbol.name, shape(node.children)] : node.symbol.name))

describe('projectRustOutline', () => {
  it('moves impl members under their type, inlining inherent ones and naming trait impls by trait', () => {
    const inherent = symbol('impl Widget', Kind.Object, 5, [symbol('new', Kind.Method, 6)])
    const source = [
      symbol('Widget', Kind.Struct, 1, [symbol('value', Kind.Field, 2)]),
      inherent,
      symbol('impl fmt::Display for Widget', Kind.Object, 10, [symbol('fmt', Kind.Method, 11)]),
    ]
    const roots = projectRustOutline(source, defaults)
    expect(shape(roots)).toEqual([['Widget', ['value', 'new', ['Display', ['fmt']]]]])
    // The cursor inside the inlined impl block makes the type the active element.
    expect(roots[0]!.activeSources).toContain(inherent)
  })

  it('folds several boilerplate impls sorted by trait name, but not a single one', () => {
    const source = [
      symbol('Widget', Kind.Struct, 1),
      symbol('impl Debug for Widget', Kind.Object, 5, [symbol('fmt', Kind.Method, 6)]),
      symbol('impl Iterator for Widget', Kind.Object, 8),
      symbol('impl Clone for Widget', Kind.Object, 10, [symbol('clone', Kind.Method, 11)]),
      symbol('Gadget', Kind.Struct, 20),
      symbol('impl Clone for Gadget', Kind.Object, 21),
    ]
    expect(shape(projectRustOutline(source, defaults))).toEqual([
      [
        'Widget',
        [
          'Iterator',
          [
            'Boilerplate (2)',
            [
              ['Clone', ['clone']],
              ['Debug', ['fmt']],
            ],
          ],
        ],
      ],
      ['Gadget', ['Clone']],
    ])
    expect(
      shape(projectRustOutline(source, { ...defaults, groupBoilerplate: false, traitImplOrder: 'position' })),
    ).toEqual([
      ['Widget', [['Debug', ['fmt']], 'Iterator', ['Clone', ['clone']]]],
      ['Gadget', ['Clone']],
    ])
  })

  it('collects impls of undeclared types in a group, or keeps them at the root', () => {
    const source = [
      symbol('Widget', Kind.Struct, 1),
      symbol('impl External', Kind.Object, 5, [symbol('run', Kind.Method, 6)]),
      symbol('impl Display for Vec<Widget>', Kind.Object, 10),
    ]
    expect(shape(projectRustOutline(source, defaults))).toEqual([
      'Widget',
      ['Other impls (2)', [['impl External', ['run']], 'impl Display for Vec<Widget>']],
    ])
    expect(shape(projectRustOutline(source, { ...defaults, orphans: 'keep' }))).toEqual([
      'Widget',
      ['impl External', ['run']],
      'impl Display for Vec<Widget>',
    ])
  })

  it('groups inherent impl members under an `impl` node in group mode', () => {
    const source = [
      symbol('Widget', Kind.Struct, 1, [symbol('value', Kind.Field, 2)]),
      symbol('impl Widget', Kind.Object, 5, [symbol('new', Kind.Method, 6)]),
      symbol('impl Widget', Kind.Object, 8, [symbol('len', Kind.Method, 9)]),
    ]
    expect(shape(projectRustOutline(source, { ...defaults, inherentMode: 'group' }))).toEqual([
      ['Widget', ['value', ['impl', ['new']], ['impl', ['len']]]],
    ])
  })

  it('hides symbols inside function bodies unless shown', () => {
    const source = [
      symbol('main', Kind.Function, 1, [symbol('config', Kind.Variable, 2), symbol('Local', Kind.Struct, 3)]),
      symbol('Widget', Kind.Struct, 10),
      symbol('impl Widget', Kind.Object, 11, [symbol('new', Kind.Method, 12, [symbol('inner', Kind.Function, 13)])]),
    ]
    expect(shape(projectRustOutline(source, defaults))).toEqual(['main', ['Widget', ['new']]])
    expect(shape(projectRustOutline(source, { ...defaults, bodyItems: 'show' }))).toEqual([
      ['main', ['config', 'Local']],
      ['Widget', [['new', ['inner']]]],
    ])
  })

  it('compacts function details according to the detail mode', () => {
    const detail = 'fn<T>(&mut self, a: Vec<(u8, u8)>, mut b :T) ->  Result<( ), E>'
    const source = [
      symbol('Widget', Kind.Struct, 1),
      symbol('impl Widget', Kind.Object, 2, [symbol('run', Kind.Method, 3, [], detail)]),
    ]
    const details = (['full', 'params', 'return', 'none'] as const).map(
      mode => projectRustOutline(source, { ...defaults, detail: mode })[0]!.children[0]!.symbol.detail,
    )
    expect(details).toEqual([
      'fn<T>(&mut self, a: Vec<(u8, u8)>, mut b :T) -> Result<( ), E>',
      '(self, a, b) -> Result<( ), E>',
      '-> Result<( ), E>',
      undefined,
    ])
  })

  it('keeps the native nesting without impl grouping', () => {
    const source = [
      symbol('Widget', Kind.Struct, 1),
      symbol('impl Debug for Widget', Kind.Object, 5, [symbol('fmt', Kind.Method, 6, [symbol('f', Kind.Variable, 7)])]),
    ]
    expect(shape(projectRustOutline(source, { ...defaults, groupImpls: false }))).toEqual([
      'Widget',
      ['impl Debug for Widget', ['fmt']],
    ])
  })
})
