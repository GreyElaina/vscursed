import { parsePluginManifest } from '@vscursed/api'
import { Codicon } from 'vscode-internal/vs/base/common/codicons.js'
import { ThemeIcon } from 'vscode-internal/vs/base/common/themables.js'
import {
  Renderer as ExtensionsListRenderer,
  type ITemplateData,
} from 'vscode-internal/vs/workbench/contrib/extensions/browser/extensionsList.js'
import type { IExtension } from 'vscode-internal/vs/workbench/contrib/extensions/common/extensions.js'
import type { Context } from 'cordis'

const indicatorClass = 'vscursed-extension-indicator'

function renderIndicator(extension: IExtension, data: ITemplateData) {
  const header = data.name.parentElement
  if (!header) return
  let indicator = header.querySelector<HTMLElement>(`.${indicatorClass}`)
  const manifest = extension.local?.manifest
  const result = manifest && parsePluginManifest(manifest)
  if (!result || !result.success || !result.data) {
    indicator?.remove()
    return
  }
  if (!indicator) {
    indicator = document.createElement('span')
    indicator.className = `extension-kind-indicator ${indicatorClass} ${ThemeIcon.asClassName(Codicon.debugAlt)}`
    indicator.title = 'VSCursed extension'
    data.name.after(indicator)
  }
}

/** Adds a VSCursed capability indicator to VS Code's existing virtualized extension list. */
export function contributeExtensionsList(ctx: Context) {
  ctx.interceptor.around(ExtensionsListRenderer.prototype, 'renderElement', function (next, extension, index, data) {
    next(extension, index, data)
    renderIndicator(extension, data)
  })
  ctx.effect(
    () => () => {
      for (const indicator of document.querySelectorAll(`.${indicatorClass}`)) indicator.remove()
    },
    'vscursed.extensionsListIndicator',
  )
}
