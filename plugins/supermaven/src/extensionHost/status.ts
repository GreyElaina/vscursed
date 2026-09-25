import { dirname } from 'node:path'
import type { Remote } from '@vscursed/api'
import type { Context } from 'cordis'
import * as vscode from 'vscode'
import {
  commands,
  type AgentStatus,
  type CompletionPresentation,
  type Connection,
  type SupermavenChannel,
  type SupermavenWindow,
} from '../protocol.ts'

const retryInterval = 2000

const literal = (text: string) => text.replace(/[\\`*_{}[\]()<>#+\-.!|~$]/g, '\\$&')

export class SupermavenStatus {
  private readonly item = vscode.window.createStatusBarItem('vscursed.supermaven', vscode.StatusBarAlignment.Right, 100)
  private readonly connectionLabels: Record<Connection, string>
  private readonly channelReady: Promise<void>
  private readonly rendererReady: Promise<void>
  private presentation: CompletionPresentation = { fetching: false, available: false, answeredAt: null }
  private status: AgentStatus | undefined
  private statusError: string | undefined
  private statusSubscription: { dispose(): unknown } | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private active = true
  private refreshVersion = 0
  private statusStarted = false

  constructor(
    ctx: Context,
    private readonly channel: Remote<SupermavenChannel>,
    private readonly renderer: Remote<SupermavenWindow>,
  ) {
    this.channelReady = ctx.bridge.ready('sharedProcess', 'supermaven')
    this.rendererReady = ctx.bridge.ready('renderer', 'supermaven.window')
    this.connectionLabels = {
      starting: vscode.l10n.t('Starting'),
      connected: vscode.l10n.t('Connected'),
      disconnected: vscode.l10n.t('Disconnected'),
      exited: vscode.l10n.t('Process exited'),
    }
    this.item.name = 'Supermaven'
    this.item.command = commands.showStatus
    this.item.show()
    ctx.effect(
      () => () => {
        this.active = false
        clearTimeout(this.retry)
        this.item.dispose()
      },
      'supermaven status bar',
    )
    ctx.effect(() => {
      const folders = vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh())
      const editor = vscode.window.onDidChangeActiveTextEditor(() => {
        if (!vscode.workspace.workspaceFolders?.length) void this.refresh()
      })
      return () => {
        folders.dispose()
        editor.dispose()
      }
    }, 'supermaven status workspace')
    this.render()
  }

  updatePresentation(presentation: CompletionPresentation) {
    this.presentation = presentation
    this.render()
    if (!this.statusStarted) {
      this.statusStarted = true
      void this.refresh()
    }
  }

  async restart() {
    await this.rendererReady
    await this.renderer.restart()
    await this.refresh()
  }

  async show() {
    const restart = vscode.l10n.t('Restart sidecar')
    const selected = await vscode.window.showInformationMessage(this.detail(), restart)
    if (selected === restart) await this.restart()
  }

  private workspace() {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (folder) return folder.uri.fsPath
    const uri = vscode.window.activeTextEditor?.document.uri
    if (uri?.scheme !== 'file') return
    return dirname(uri.fsPath)
  }

  private async refresh() {
    const version = ++this.refreshVersion
    clearTimeout(this.retry)
    this.retry = undefined
    const workspace = this.workspace()
    if (!workspace) {
      this.status = undefined
      this.statusError = undefined
      this.render()
      return
    }
    try {
      await this.channelReady
      if (!this.statusSubscription) {
        this.statusSubscription = this.channel.onDidChangeStatus(change => {
          if (change.workspace !== this.workspace()) return
          this.status = change.status
          this.statusError = undefined
          this.render()
        })
      }
      const status = await this.channel.status(workspace)
      if (!this.active || version !== this.refreshVersion || workspace !== this.workspace()) return
      this.status = status
      this.statusError = undefined
    } catch (error) {
      if (!this.active || version !== this.refreshVersion || workspace !== this.workspace()) return
      this.statusError = error instanceof Error ? error.message : String(error)
      if (this.active) this.retry = setTimeout(() => void this.refresh(), retryInterval)
    }
    this.render()
  }

  private state() {
    return this.statusError
      ? vscode.l10n.t('Unable to connect')
      : this.status
        ? this.connectionLabels[this.status.connection]
        : vscode.l10n.t('Not started')
  }

  private completion() {
    return this.presentation.fetching
      ? vscode.l10n.t('Fetching')
      : this.presentation.available
        ? vscode.l10n.t('Completion available')
        : vscode.l10n.t('No completion')
  }

  private lines(markdown: boolean) {
    const display = (text: string) => (markdown ? literal(text) : text)
    const lines = [
      vscode.l10n.t('Connection: {0}', display(this.state())),
      ...(this.statusError ? [vscode.l10n.t('Error: {0}', display(this.statusError))] : []),
      vscode.l10n.t(
        'Account: {0}',
        display(this.status?.email ?? this.status?.tier ?? vscode.l10n.t('Unknown account')),
      ),
      vscode.l10n.t('Completion: {0}', this.completion()),
    ]
    if (this.presentation.answeredAt) {
      const time = new Date(this.presentation.answeredAt).toLocaleTimeString(vscode.env.language)
      lines.push(vscode.l10n.t('Latest answer: {0}', display(time)))
    }
    return lines
  }

  private detail() {
    return this.lines(false).join('\n')
  }

  private render() {
    const state = this.state()
    const completion = this.completion()
    const connection = this.status?.connection
    const icon = this.presentation.fetching
      ? '$(sync~spin)'
      : connection !== 'connected'
        ? '$(circle-slash)'
        : this.presentation.available
          ? '$(check)'
          : '$(circle-outline)'
    const tooltip = new vscode.MarkdownString(
      `**Supermaven**\n\n${this.lines(true).join('  \n')}\n\n---\n\n[$(debug-restart) ${vscode.l10n.t('Restart sidecar')}](command:${commands.restart})`,
      true,
    )
    tooltip.isTrusted = { enabledCommands: [commands.restart] }
    tooltip.supportThemeIcons = true
    this.item.text = `${icon} Supermaven`
    this.item.tooltip = tooltip
    this.item.accessibilityInformation = { label: vscode.l10n.t('Supermaven: {0}, {1}', state, completion) }
    this.item.backgroundColor =
      this.statusError || connection === 'exited'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : connection === 'disconnected'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined
  }
}
