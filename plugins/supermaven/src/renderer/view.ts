import type { Remote } from '@vscursed/api'
import type { Context, Logger } from 'cordis'
import type { IDisposable } from 'vscode-internal/vs/base/common/lifecycle.js'
import {
  ContentWidgetPositionPreference,
  type ICodeEditor,
  type IContentWidget,
} from 'vscode-internal/vs/editor/browser/editorBrowser.js'
import type { ICodeEditorService } from 'vscode-internal/vs/editor/browser/services/codeEditorService.js'
import type { IEditorDecorationsCollection } from 'vscode-internal/vs/editor/common/editorCommon.js'
import type { ICommandService } from 'vscode-internal/vs/platform/commands/common/commands.js'
import type { IContextKey, IContextKeyService } from 'vscode-internal/vs/platform/contextkey/common/contextkey.js'
import type { Config } from '../config.ts'
import type {
  CompletionPresentation,
  RendererMessages,
  SupermavenChannel,
  SupermavenExtensionHost,
} from '../protocol.ts'
import { lineReadyContext } from '../protocol.ts'
import type { SupermavenCompletions } from './provider.ts'

const style = `
.vscursed-supermaven-hint {
  padding: 2px 8px;
  border: 1px solid var(--vscode-editorWidget-border, #777);
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, #252526);
  color: var(--vscode-editorWidget-foreground, #ccc);
  font: 11px var(--vscode-font-family);
  white-space: nowrap;
  width: max-content;
  pointer-events: none;
}
.vscursed-supermaven-return {
  padding-left: .35em;
  color: var(--vscode-editorGhostText-foreground, #888);
}
`

export interface ViewOptions {
  editors: ICodeEditorService
  commands: ICommandService
  contextKeys: IContextKeyService
  channel: Remote<SupermavenChannel>
  extensionHost: Remote<SupermavenExtensionHost>
  completions: SupermavenCompletions
  config: Config
  messages: RendererMessages
}

/**
 * Supermaven's editor presentation: the ⌥ hint of subtle mode, the ⏎ mark for a line that ghost text
 * cannot show, and the context key of the ⌥⇥ keybinding. Subtle mode reveals completions while ⌥ is
 * held. The extension host receives the status presentation through its typed bridge channel.
 */
export class SupermavenView {
  private active = true
  private readonly logger: Logger
  private readonly hint = document.createElement('div')
  private readonly widget: IContentWidget
  private readonly lineReady: IContextKey<boolean>
  private focused = document.hasFocus()
  private hintHost: ICodeEditor | undefined
  private mark: { editor: ICodeEditor; decorations: IEditorDecorationsCollection } | undefined
  private presentation = ''

  constructor(
    ctx: Context,
    private readonly options: ViewOptions,
  ) {
    const { config, editors } = options
    this.logger = ctx.logger('supermaven')
    // Requests that were in flight may settle after unloading.
    ctx.effect(() => () => void (this.active = false), 'supermaven view')

    ctx.effect(() => {
      const sheet = document.createElement('style')
      sheet.textContent = style
      document.head.append(sheet)
      return () => sheet.remove()
    }, 'supermaven style sheet')

    this.hint.className = 'vscursed-supermaven-hint'
    this.hint.setAttribute('aria-hidden', 'true')
    this.widget = {
      getId: () => 'vscursed.supermaven.hint',
      getDomNode: () => this.hint,
      getPosition: () => {
        const position = this.hintHost?.getPosition()
        return position
          ? { position, preference: [ContentWidgetPositionPreference.BELOW, ContentWidgetPositionPreference.ABOVE] }
          : null
      },
      afterRender: () => this.keepHintInside(),
    }
    ctx.effect(
      () => () => {
        this.hideHint()
        this.hideMark()
      },
      'supermaven editor hints',
    )

    this.lineReady = options.contextKeys.createKey(lineReadyContext, false)
    ctx.effect(() => () => this.lineReady.reset(), 'supermaven context key')

    const listen = <K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void) =>
      ctx.effect(() => {
        // Capturing on the window sees ⌥ before the workbench's keybinding dispatch does.
        window.addEventListener(type, listener, true)
        return () => window.removeEventListener(type, listener, true)
      }, `supermaven ${type} listener`)
    if (config.mode === 'subtle') {
      listen('keydown', event => this.reveal(event.altKey))
      listen('keyup', event => {
        if (!event.altKey || event.key === 'Alt') this.reveal(false)
      })
      listen('mousedown', event => this.reveal(event.altKey))
    }
    listen('blur', () => {
      this.focused = false
      if (config.mode === 'subtle') this.reveal(false)
      this.paint()
    })
    listen('focus', () => {
      this.focused = true
      this.paint()
    })

    ctx.on('supermaven/change', () => this.paint())
    ctx.effect(() => {
      const observed = new Map<ICodeEditor, IDisposable[]>()
      const release = (editor: ICodeEditor) => {
        for (const listener of observed.get(editor) ?? []) listener.dispose()
        observed.delete(editor)
      }
      const observe = (editor: ICodeEditor) => {
        if (observed.has(editor)) return
        const paint = () => this.paint()
        observed.set(editor, [
          editor.onDidChangeCursorSelection(paint),
          editor.onDidFocusEditorText(paint),
          editor.onDidBlurEditorText(paint),
          editor.onDidChangeModel(paint),
          editor.onDidDispose(() => release(editor)),
        ])
      }
      editors.listCodeEditors().forEach(observe)
      const added = editors.onCodeEditorAdd(observe)
      return () => {
        added.dispose()
        ;[...observed.keys()].forEach(release)
      }
    }, 'supermaven editor listeners')

    this.paint()
  }

  paint() {
    if (!this.active) return
    const { editors, completions, config } = this.options
    const editor = this.focused ? editors.getFocusedCodeEditor() : null
    const model = editor?.getModel()
    const position = editor?.getPosition()
    const edit =
      editor && model && position && editor.getSelection()?.isEmpty() ? completions.session(model).read(position) : null
    if (editor && edit && config.mode === 'subtle') {
      this.hint.textContent = completions.revealed
        ? `⌥ ⇥ ${this.options.messages.accept}`
        : `⌥ ${this.options.messages.preview}`
      this.showHint(editor)
    } else this.hideHint()
    if (editor && model && position && edit?.onNewLine && completions.revealed) {
      this.showMark(editor, position.lineNumber, model.getLineMaxColumn(position.lineNumber))
    } else this.hideMark()
    this.lineReady.set(!!edit && completions.revealed)
    this.report({
      fetching: completions.pending > 0,
      available: !!edit,
      answeredAt: completions.answeredAt ?? null,
    })
  }

  async restart() {
    await this.options.channel.restart()
    this.options.completions.reset()
  }

  private reveal(revealed: boolean) {
    const { completions, commands } = this.options
    if (completions.revealed === revealed) return
    completions.revealed = revealed
    this.paint()
    commands
      .executeCommand(revealed ? 'editor.action.inlineSuggest.trigger' : 'editor.action.inlineSuggest.hide')
      .catch(error => this.logger.warn(error))
  }

  private showHint(editor: ICodeEditor) {
    if (this.hintHost !== editor) {
      this.hideHint()
      this.hintHost = editor
      editor.addContentWidget(this.widget)
    }
    editor.layoutContentWidget(this.widget)
  }

  private hideHint() {
    this.hintHost?.removeContentWidget(this.widget)
    this.hintHost = undefined
  }

  /** Shifts the hint left where it would overflow the editor's content area. */
  private keepHintInside() {
    const host = this.hintHost
    const node = host?.getDomNode()
    if (!host || !node) return
    this.hint.style.transform = ''
    const hint = this.hint.getBoundingClientRect()
    const bounds = node.getBoundingClientRect()
    const { contentLeft, contentWidth } = host.getLayoutInfo()
    const excess = hint.right - bounds.left - contentLeft - contentWidth
    if (excess > 0) {
      this.hint.style.transform = `translateX(${-Math.min(excess, hint.left - bounds.left - contentLeft)}px)`
    }
  }

  private showMark(editor: ICodeEditor, lineNumber: number, endColumn: number) {
    if (this.mark?.editor !== editor) {
      this.hideMark()
      this.mark = { editor, decorations: editor.createDecorationsCollection() }
    }
    this.mark.decorations.set([
      {
        range: { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn },
        options: {
          description: 'vscursed-supermaven-return',
          showIfCollapsed: true,
          after: { content: '⏎', inlineClassName: 'vscursed-supermaven-return' },
        },
      },
    ])
  }

  private hideMark() {
    this.mark?.decorations.clear()
    this.mark = undefined
  }

  private report(presentation: CompletionPresentation) {
    const serialized = JSON.stringify(presentation)
    if (serialized === this.presentation) return
    this.presentation = serialized
    this.options.extensionHost.updatePresentation(presentation).catch(error => this.logger.warn(error))
  }
}
