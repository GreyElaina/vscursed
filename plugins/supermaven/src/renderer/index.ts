import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import { ICodeEditorService } from 'vscode-internal/vs/editor/browser/services/codeEditorService.js'
import { ILanguageService } from 'vscode-internal/vs/editor/common/languages/language.js'
import type { ITextModel } from 'vscode-internal/vs/editor/common/model.js'
import { ILanguageFeaturesService } from 'vscode-internal/vs/editor/common/services/languageFeatures.js'
import { ICommandService } from 'vscode-internal/vs/platform/commands/common/commands.js'
import { IContextKeyService } from 'vscode-internal/vs/platform/contextkey/common/contextkey.js'
import { IUriIdentityService } from 'vscode-internal/vs/platform/uriIdentity/common/uriIdentity.js'
import { IWorkspaceContextService } from 'vscode-internal/vs/platform/workspace/common/workspace.js'
import type { Config } from '../config.ts'
import type {} from '../protocol.ts'
import { followAcceptances } from './editing.ts'
import { SupermavenCompletions, type DocumentLocation } from './provider.ts'
import { SupermavenView } from './view.ts'

export { Config } from '../config.ts'

export const name = 'supermaven'
export const inject = ['bridge', 'interceptor', 'vscode']

/** Renderer half of Supermaven: the inline completion provider, what accepting its items does, and its presentation. */
export async function apply(ctx: Context, config: Config) {
  const workspace = ctx.vscode.get(IWorkspaceContextService)
  const languages = ctx.vscode.get(ILanguageService)
  const editors = ctx.vscode.get(ICodeEditorService)
  const commands = ctx.vscode.get(ICommandService)
  const { extUri } = ctx.vscode.get(IUriIdentityService)
  const registry = ctx.vscode.get(ILanguageFeaturesService).inlineCompletionsProvider
  const channel = ctx.bridge.connect('sharedProcess', 'supermaven')
  const extensionHost = ctx.bridge.connect('extensionHost', 'supermaven.extensionHost')
  await ctx.bridge.ready('extensionHost', 'supermaven.extensionHost')
  const messages = await extensionHost.messages()

  /** sm-agent needs a file inside a directory it runs in. */
  const locate = (model: ITextModel): DocumentLocation | undefined => {
    const { uri } = model
    if (uri.scheme === 'file') {
      const folder = workspace.getWorkspaceFolder(uri)
      const file = folder && extUri.relativePath(folder.uri, uri)
      return folder && file
        ? { workspace: folder.uri.fsPath, file }
        : { workspace: extUri.dirname(uri).fsPath, file: extUri.basename(uri) }
    }
    // Other documents (untitled ones, for instance) are placed in the first folder, named for their language.
    const folder = workspace.getWorkspace().folders[0]
    const extension = languages.getExtensions(model.getLanguageId())[0]
    if (!folder || !extension) return
    return { workspace: folder.uri.fsPath, file: `${extUri.basename(uri)}${extension}` }
  }

  const completions = new SupermavenCompletions(ctx, channel, config, locate)
  const acceptLine = followAcceptances(ctx, commands, editors, completions)
  const view = new SupermavenView(ctx, {
    editors,
    commands,
    contextKeys: ctx.vscode.get(IContextKeyService),
    channel,
    extensionHost,
    completions,
    config,
    messages,
  })
  // The commands that the extension host registers for this window.
  ctx.bridge.provide('renderer', 'supermaven.window', {
    acceptLine: async () => {
      const editor = editors.getFocusedCodeEditor()
      if (editor) await acceptLine(editor)
    },
    restart: () => view.restart(),
  })

  ctx.effect(() => {
    const registration = registry.register('*', completions)
    return () => registration.dispose()
  }, 'supermaven provider')
  // Supermaven replaces the other inline completion providers rather than competing with them.
  ctx.interceptor.around(registry, 'all', (next, model) =>
    model && config.trigger.enabled ? [completions] : next(model),
  )
}
