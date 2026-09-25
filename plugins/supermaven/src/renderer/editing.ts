import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import type { ICodeEditor } from 'vscode-internal/vs/editor/browser/editorBrowser.js'
import type { ICodeEditorService } from 'vscode-internal/vs/editor/browser/services/codeEditorService.js'
import type { ITextModel } from 'vscode-internal/vs/editor/common/model.js'
import type { ICommandService } from 'vscode-internal/vs/platform/commands/common/commands.js'
import type { Acceptance, SupermavenCompletions } from './provider.ts'

const editSource = 'vscursed.supermaven'

/**
 * Follows up on accepted items: a text line fetches the rest of its answer, a skip or delete marker is
 * removed again and its action applied. Returns the ⌥⇥ action, which accepts the next line of the answer
 * in an editor, including one that ghost text cannot show.
 */
export function followAcceptances(
  ctx: Context,
  commands: ICommandService,
  editors: ICodeEditorService,
  completions: SupermavenCompletions,
) {
  const logger = ctx.logger('supermaven')
  const trigger = () => commands.executeCommand('editor.action.inlineSuggest.trigger')

  const editorOf = (model: ITextModel) => {
    const editor = editors.listCodeEditors().find(editor => editor.getModel() === model)
    if (!editor) throw new Error('the editor of the Supermaven completion is gone')
    return editor
  }

  /** Removes the marker that accepting a skip or delete item typed before the caret; returns its line. */
  const removeMarker = (editor: ICodeEditor, model: ITextModel, marker: string) => {
    const caret = editor.getPosition()
    if (!caret) throw new Error('the Supermaven editor has no caret')
    const column = caret.column - marker.length
    if (model.getLineContent(caret.lineNumber).slice(column - 1, caret.column - 1) !== marker) {
      throw new Error('the Supermaven marker changed before it was applied')
    }
    const range = {
      startLineNumber: caret.lineNumber,
      startColumn: column,
      endLineNumber: caret.lineNumber,
      endColumn: caret.column,
    }
    editor.executeEdits(editSource, [{ range, text: '' }])
    return caret.lineNumber
  }

  const skip = async (model: ITextModel, marker: string, lines: number) => {
    const editor = editorOf(model)
    const lineNumber = removeMarker(editor, model, marker)
    const target = Math.min(lineNumber + lines, model.getLineCount())
    editor.setPosition({ lineNumber: target, column: model.getLineMaxColumn(target) })
    await trigger()
  }

  const remove = (model: ITextModel, marker: string, lines: readonly string[]) => {
    const editor = editorOf(model)
    const caretLine = editor.getPosition()!.lineNumber
    lines.forEach((expected, index) => {
      const line = caretLine + 1 + index
      if (line > model.getLineCount() || model.getLineContent(line).trimEnd() !== expected.trimEnd()) {
        throw new Error('the Supermaven deletion no longer matches the document')
      }
    })
    const lineNumber = removeMarker(editor, model, marker)
    const last = lineNumber + lines.length
    // The deleted lines go with their line breaks; at the end of the document, with the break before them.
    const range =
      last < model.getLineCount()
        ? { startLineNumber: lineNumber + 1, startColumn: 1, endLineNumber: last + 1, endColumn: 1 }
        : {
            startLineNumber: lineNumber,
            startColumn: model.getLineMaxColumn(lineNumber),
            endLineNumber: last,
            endColumn: model.getLineMaxColumn(last),
          }
    editor.executeEdits(editSource, [{ range, text: '' }])
  }

  const follow = async (acceptance: Acceptance) => {
    const { model } = acceptance
    switch (acceptance.kind) {
      case 'text':
        await completions.accepted(model, acceptance.key)
        return trigger()
      case 'skip':
        return skip(model, acceptance.marker, acceptance.lines)
      case 'delete':
        return remove(model, acceptance.marker, acceptance.lines)
    }
  }
  ctx.on('supermaven/accept', acceptance => {
    follow(acceptance).catch(error => logger.warn(error))
  })

  /** Accepts the next line in `editor`; resolves at once when there is none. */
  return async function acceptLine(editor: ICodeEditor) {
    const model = editor.getModel()
    const position = editor.getPosition()
    if (!model || !position || !completions.revealed) return
    const session = completions.session(model)
    const edit = session.read(position)
    const key = session.prediction?.key
    if (!edit || !key) return
    if (!edit.onNewLine) {
      await commands.executeCommand('editor.action.inlineSuggest.commit')
      return
    }
    const start = model.getOffsetAt(position) - (position.column - edit.range.startColumn)
    editor.executeEdits(editSource, [{ range: edit.range, text: edit.insertText }])
    editor.setPosition(model.getPositionAt(start + edit.insertText.length))
    await completions.accepted(model, key)
    await trigger()
  }
}
