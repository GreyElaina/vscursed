import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import type { ICodeEditor } from 'vscode-internal/vs/editor/browser/editorBrowser.js'
import { ICodeEditorService } from 'vscode-internal/vs/editor/browser/services/codeEditorService.js'

export const name = 'reveal-at-top'
export const inject = ['interceptor', 'vscode']

const method = 'revealRangeNearTopIfOutsideViewport'

export function apply(ctx: Context) {
  // `CodeEditorWidget` is not importable, but every instance registers itself with the code editor service in
  // its constructor, so any live editor leads to the prototype that defines the method for all of them.
  const wrap = (editor: ICodeEditor) => {
    let owner: object | null = editor
    while (owner && !Object.hasOwn(owner, method)) owner = Object.getPrototypeOf(owner)
    if (!owner) {
      ctx.logger('reveal-at-top').warn('code editors do not define %s', method)
      return
    }
    ctx.interceptor.around(owner as ICodeEditor, method, function (_next, range, scrollType) {
      this.revealRangeAtTop(range, scrollType)
    })
  }

  const editors = ctx.vscode.get(ICodeEditorService)
  const [editor] = editors.listCodeEditors()
  if (editor) {
    wrap(editor)
    return
  }
  ctx.effect(() => {
    const subscription = editors.onCodeEditorAdd(editor => {
      subscription.dispose()
      wrap(editor)
    })
    return () => subscription.dispose()
  }, 'reveal-at-top: wait for the first code editor')
}
