import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import { IProductService } from 'vscode-internal/vs/platform/product/common/productService.js'

export { Config } from './shared.ts'

export const name = 'sample-realms'
export const inject = ['bridge', 'vscode']

export function apply(ctx: Context) {
  const product = ctx.vscode.get(IProductService)
  ctx.bridge.provide('main', 'sample.main', {
    describe: () => ({ realm: 'main', pid: process.pid, detail: `${product.nameLong} ${product.version}` }),
  })
}
