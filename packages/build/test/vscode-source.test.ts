import { describe, expect, it } from 'vite-plus/test'
import { readModuleValues, sourceFile } from '../src/vscode-source.ts'

describe('readModuleValues', () => {
  it('finds service identifiers and enums of a VS Code module', () => {
    const values = readModuleValues(sourceFile('vs/workbench/services/statusbar/browser/statusbar.js'))
    expect(values.services.get('IStatusbarService')).toBe('statusbarService')
    expect(values.enums.get('StatusbarAlignment')).toEqual({ LEFT: 0, RIGHT: 1, 0: 'LEFT', 1: 'RIGHT' })
  })

  it('follows refined identifiers to the imported decorator', () => {
    const values = readModuleValues(
      sourceFile('vs/workbench/services/extensionManagement/common/extensionManagement.js'),
    )
    expect(values.services.get('IWorkbenchExtensionManagementService')).toBe('extensionManagementService')
  })

  it('evaluates constant enum members', () => {
    const values = readModuleValues(sourceFile('vs/platform/files/common/files.js'))
    const permissions = values.enums.get('FilePermission')
    expect(permissions?.Readonly).toBe(1)
  })
})
