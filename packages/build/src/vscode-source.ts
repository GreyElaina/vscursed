import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseSync } from 'rolldown/utils'

/** `src/` of the VSCodium working directory whose types and identifiers plugins build against. */
export const vscodeSource = resolve(
  process.env.VSCURSED_VSCODE_SOURCE ?? join(import.meta.dirname, '../../../upstream/vscodium/vscode/src'),
)

export type EnumValue = number | string

/** The values a plugin may take from a VS Code module: service identifiers by id, and enum members. */
export interface ModuleValues {
  services: Map<string, string>
  enums: Map<string, Record<string, EnumValue>>
}

const cache = new Map<string, ModuleValues>()

/** The source file of a `vs/...` module specifier, which VS Code writes with a `.js` extension. */
export function sourceFile(specifier: string) {
  const file = join(vscodeSource, specifier.replace(/\.js$/, '') + '.ts')
  if (!existsSync(file)) throw new Error(`vscode-internal/${specifier} does not exist in ${vscodeSource}`)
  return file
}

type Node = { type: string; [key: string]: any }

interface EnumScope {
  name: string
  members: Record<string, EnumValue>
  /** Another enum that a member refers to, declared in this module or imported into it. */
  other(name: string): Record<string, EnumValue> | undefined
}

function evaluate(node: Node, scope: EnumScope): EnumValue {
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'number' || typeof node.value === 'string') return node.value
      break
    case 'UnaryExpression': {
      const value = evaluate(node.argument, scope)
      if (typeof value === 'number') {
        if (node.operator === '-') return -value
        if (node.operator === '+') return value
        if (node.operator === '~') return ~value
      }
      break
    }
    case 'BinaryExpression': {
      const left = evaluate(node.left, scope)
      const right = evaluate(node.right, scope)
      if (node.operator === '+' && (typeof left === 'string' || typeof right === 'string')) return `${left}${right}`
      if (typeof left === 'number' && typeof right === 'number') {
        const operators: Record<string, (a: number, b: number) => number> = {
          '+': (a, b) => a + b,
          '-': (a, b) => a - b,
          '*': (a, b) => a * b,
          '/': (a, b) => a / b,
          '%': (a, b) => a % b,
          '<<': (a, b) => a << b,
          '>>': (a, b) => a >> b,
          '>>>': (a, b) => a >>> b,
          '|': (a, b) => a | b,
          '&': (a, b) => a & b,
          '^': (a, b) => a ^ b,
        }
        const operator = operators[node.operator]
        if (operator) return operator(left, right)
      }
      break
    }
    case 'ParenthesizedExpression':
      return evaluate(node.expression, scope)
    case 'Identifier':
      if (node.name in scope.members) return scope.members[node.name]!
      break
    case 'MemberExpression': {
      if (node.object.type !== 'Identifier' || node.property.type !== 'Identifier') break
      const members = node.object.name === scope.name ? scope.members : scope.other(node.object.name)
      if (members && node.property.name in members) return members[node.property.name]!
      break
    }
  }
  throw new Error(`enum ${scope.name} has a member value that is not a constant expression`)
}

function readEnum(declaration: Node, other: EnumScope['other']) {
  const enumName: string = declaration.id.name
  const members: Record<string, EnumValue> = {}
  const scope: EnumScope = { name: enumName, members, other }
  let next: EnumValue | undefined = 0
  for (const member of declaration.body?.members ?? declaration.members) {
    const name: string = member.id.type === 'Identifier' ? member.id.name : member.id.value
    let value: EnumValue
    if (member.initializer) value = evaluate(member.initializer, scope)
    else if (typeof next === 'number') value = next
    else throw new Error(`enum ${enumName}.${name} needs an initializer`)
    members[name] = value
    next = typeof value === 'number' ? value + 1 : undefined
  }
  const runtime: Record<string, EnumValue> = {}
  for (const [name, value] of Object.entries(members)) {
    runtime[name] = value
    // Numeric members have TypeScript's reverse mapping.
    if (typeof value === 'number') runtime[value] = name
  }
  return runtime
}

/**
 * Reads the service identifiers (`createDecorator('id')`, including refinements of an imported
 * identifier) and the enums that a VS Code module exports, without type checking or evaluating it.
 */
export function readModuleValues(file: string): ModuleValues {
  const cached = cache.get(file)
  if (cached) return cached
  const { program, errors } = parseSync(file, readFileSync(file, 'utf8'), { lang: 'ts' })
  if (errors.length) throw new Error(`cannot parse ${file}: ${errors[0]!.message}`)
  const values: ModuleValues = { services: new Map(), enums: new Map() }
  cache.set(file, values)
  const localEnums = new Map<string, Record<string, EnumValue>>()
  const otherEnum = (name: string) => localEnums.get(name) ?? resolveImported(file, imports.get(name), 'enums')

  const imports = new Map<string, { source: string; imported: string }>()
  const local = new Map<string, string>()
  const refinements: { name: string; base: string; exported: boolean }[] = []
  for (const statement of program.body as Node[]) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) {
        if (specifier.type !== 'ImportSpecifier') continue
        const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
        imports.set(specifier.local.name, { source: statement.source.value, imported })
      }
      continue
    }
    const exported = statement.type === 'ExportNamedDeclaration'
    const declaration: Node | undefined = exported ? statement.declaration : statement
    if (!declaration) continue
    if (declaration.type === 'TSEnumDeclaration') {
      try {
        const members = readEnum(declaration, otherEnum)
        localEnums.set(declaration.id.name, members)
        if (exported) values.enums.set(declaration.id.name, members)
      } catch {
        // An enum whose values need evaluation is not offered as a value; importing it fails the build.
      }
    }
    if (declaration.type !== 'VariableDeclaration') continue
    for (const declarator of declaration.declarations) {
      const init: Node | undefined = declarator.init
      if (declarator.id.type !== 'Identifier' || init?.type !== 'CallExpression' || init.callee.type !== 'Identifier')
        continue
      const name: string = declarator.id.name
      if (init.callee.name === 'createDecorator' && init.arguments[0]?.type === 'Literal') {
        local.set(name, init.arguments[0].value)
        if (exported) values.services.set(name, init.arguments[0].value)
      } else if (init.callee.name === 'refineServiceDecorator' && init.arguments[0]?.type === 'Identifier') {
        refinements.push({ name, base: init.arguments[0].name, exported })
      }
    }
  }
  // In declaration order, so that a refinement of a refinement finds its base.
  for (const { name, base, exported } of refinements) {
    const id = local.get(base) ?? resolveImported(file, imports.get(base), 'services')
    if (!id) continue
    local.set(name, id)
    if (exported) values.services.set(name, id)
  }
  return values
}

function resolveImported<K extends keyof ModuleValues>(
  file: string,
  binding: { source: string; imported: string } | undefined,
  kind: K,
) {
  if (!binding?.source.startsWith('.')) return
  const target = resolve(dirname(file), binding.source.replace(/\.js$/, '') + '.ts')
  if (!existsSync(target)) return
  return readModuleValues(target)[kind].get(binding.imported) as ModuleValues[K] extends Map<string, infer V>
    ? V | undefined
    : never
}
