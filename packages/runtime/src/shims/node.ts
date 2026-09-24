/**
 * Stands in for the Node built-ins that `@cordisjs/plugin-loader` imports, in the sandboxed renderer.
 * The runtime supplies modules itself, so the Loader never reaches these paths there.
 */
function unavailable(name: string) {
  return () => {
    throw new Error(`${name} is not available in the renderer`)
  }
}

export const createRequire = unavailable('module.createRequire')
export const existsSync = unavailable('fs.existsSync')
export const mkdir = unavailable('fs.mkdir')
export const rename = unavailable('fs.rename')
export const writeFile = unavailable('fs.writeFile')
export const dirname = unavailable('path.dirname')
export const join = unavailable('path.join')
export const fileURLToPath = unavailable('url.fileURLToPath')
export const pathToFileURL = unavailable('url.pathToFileURL')
