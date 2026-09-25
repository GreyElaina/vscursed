import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import { IModelService } from 'vscode-internal/vs/editor/common/services/model.js'
import type { IEditorPane } from 'vscode-internal/vs/workbench/common/editor.js'
import {
  type IOutlineCreator,
  IOutlineService,
  OutlineTarget,
} from 'vscode-internal/vs/workbench/services/outline/browser/outline.js'
import { z } from 'zod'
import { ProjectedOutline } from './outline.ts'
import type {} from './protocol.ts'

// Zod compiles validators with `new Function` unless told otherwise; the workbench's Trusted Types policy forbids that.
z.config({ jitless: true })

export const name = 'rust-outline'
export const inject = ['bridge', 'interceptor', 'vscode']

const defaultBoilerplateTraits = [
  'Debug',
  'Clone',
  'Copy',
  'Default',
  'PartialEq',
  'Eq',
  'PartialOrd',
  'Ord',
  'Hash',
  'Send',
  'Sync',
  'Unpin',
  'Sized',
  'Unsize',
  'From',
  'TryFrom',
  'Into',
  'TryInto',
  'FromStr',
  'FromIterator',
  'IntoIterator',
  'AsRef',
  'AsMut',
  'Borrow',
  'BorrowMut',
  'Deref',
  'DerefMut',
  'Drop',
  'Write',
  'Serialize',
  'Deserialize',
  'Index',
  'IndexMut',
  'Add',
  'Sub',
  'Mul',
  'Div',
  'Rem',
  'Neg',
  'Not',
  'BitAnd',
  'BitOr',
  'BitXor',
  'Shl',
  'Shr',
]

export const Config = z
  .object({
    groupImpls: z
      .boolean()
      .default(true)
      .describe(
        'Move `impl` blocks under the type they implement. When off, symbols keep their native nesting; `bodyItems` and `detail` still apply.',
      ),
    inherentMode: z
      .enum(['inline', 'group'])
      .default('inline')
      .describe('Show members of `impl Type` blocks directly under the type (`inline`) or in an `impl` node.'),
    traitImplOrder: z
      .enum(['name', 'position'])
      .default('name')
      .describe('Order trait impls under a type by trait name or by position in the document.'),
    groupBoilerplate: z
      .boolean()
      .default(true)
      .describe('Fold impls of `boilerplateTraits` into one `Boilerplate (n)` node when a type has more than one.'),
    boilerplateTraits: z
      .array(z.string().min(1))
      .default(defaultBoilerplateTraits)
      .describe('Trait names (last path segment, case-insensitive) whose impls count as boilerplate.'),
    orphans: z
      .enum(['group', 'keep'])
      .default('group')
      .describe(
        'Impls of types not declared in the document: collect them in `Other impls (n)` or keep them at the root.',
      ),
    bodyItems: z
      .enum(['hide', 'show'])
      .default('hide')
      .describe('Show or hide symbols declared inside function bodies.'),
    detail: z
      .enum(['full', 'params', 'return', 'none'])
      .default('params')
      .describe('Function detail: the full signature, parameter names and return type, the return type only, or none.'),
  })
  .strict()

const noOutline: IOutlineCreator<IEditorPane, unknown> = {
  matches: (_pane): _pane is IEditorPane => false,
  createOutline: async () => undefined,
}

export async function apply(ctx: Context, config: z.output<typeof Config>) {
  await ctx.bridge.ready('extensionHost', 'rust-outline.extensionHost')
  const labels = await ctx.bridge.connect('extensionHost', 'rust-outline.extensionHost').messages()
  const outlines = ctx.vscode.get(IOutlineService)
  const models = ctx.vscode.get(IModelService)
  const refresh = () => outlines.registerOutlineCreator(noOutline).dispose()

  const remove = ctx.interceptor.around(outlines, 'createOutline', async function (next, pane, target, token) {
    const outline = await next(pane, target, token)
    if (!outline || target !== OutlineTarget.OutlinePane || outline.outlineKind !== 'documentSymbols') return outline
    return new ProjectedOutline(
      ctx,
      outline,
      { ...config, labels },
      uri => models.getModel(uri)?.getLanguageId() === 'rust',
    )
  })
  refresh()
  // The outlines created while this plugin is gone must not see the layer, so it is removed before refreshing.
  ctx.effect(
    () => async () => {
      await remove()
      refresh()
    },
    'rust-outline: recreate outlines',
  )
}
