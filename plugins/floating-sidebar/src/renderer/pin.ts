import type { Context } from 'cordis'
import type { IHoverService } from 'vscode-internal/vs/platform/hover/browser/hover.js'
import type { FloatingSide } from './side.ts'
import { pinClass } from './style.ts'

/** The pin in the title of a side bar: filled while the side bar is pinned, outlined while it floats. */
export class PinButton {
  private readonly element = document.createElement('div')

  constructor(
    ctx: Context,
    private readonly side: FloatingSide,
    hovers: IHoverService,
    private readonly label: () => string,
    toggle: () => void,
  ) {
    const element = this.element
    element.classList.add(pinClass, 'codicon')
    element.role = 'button'
    element.tabIndex = 0
    element.addEventListener('click', toggle)
    element.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      event.stopPropagation()
      toggle()
    })
    this.update()

    ctx.effect(() => {
      const title = side.element.querySelector(':scope > .title')
      if (!title) throw new Error(`floating-sidebar: the ${side.spec.id} side bar has no title area`)
      title.append(element)
      const hover = hovers.setupDelayedHover(element, () => ({ content: this.label() }))
      return () => {
        hover.dispose()
        element.remove()
      }
    }, `floating-sidebar: ${side.spec.id} pin button`)
  }

  update() {
    const pinned = !this.side.floating
    this.element.classList.toggle('codicon-pinned', pinned)
    this.element.classList.toggle('codicon-pin', !pinned)
    this.element.ariaPressed = String(pinned)
    this.element.ariaLabel = this.label()
  }
}
