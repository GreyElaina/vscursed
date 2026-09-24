import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createVSIX } from '@vscode/vsce'

/** Packages the plugin extension in `root` as `<name>-<version>.vsix`, from its built files only. */
export async function packageVsix(root = process.cwd()) {
  const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const packagePath = join(root, `${name}-${version}.vsix`)
  await createVSIX({
    cwd: root,
    packagePath,
    dependencies: false,
    allowMissingRepository: true,
    skipLicense: true,
  })
  return packagePath
}
