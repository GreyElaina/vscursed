import inspector from 'node:inspector'
import type { PluginManifest, ProviderRegistration } from '@vscursed/api'
import { DevelopmentProvider } from '@vscursed/build'
import { generateRandomPipeName } from 'vscode-jsonrpc/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { NodeDebugEndpoints } from '../src/vscode/debug.ts'
import type { ProviderEvent } from '../src/vscode/development.ts'
import { ProviderConnection } from '../src/vscode/provider-connection.ts'

const extensionId = 'test.clock'
const workspace = '/workspaces/clock'
const manifest: PluginManifest = { renderer: './dist/renderer.js', main: './dist/main.js' }

describe('ProviderConnection', () => {
  const connections: ProviderConnection[] = []

  beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => {}))
  afterEach(() => {
    for (const connection of connections.splice(0)) connection.dispose()
    vi.restoreAllMocks()
  })

  function connect(registration: Partial<ProviderRegistration> = {}) {
    const endpoint = generateRandomPipeName()
    const provider = new DevelopmentProvider(extensionId, workspace, manifest, endpoint)
    const events: ProviderEvent[] = []
    const connection = new ProviderConnection({ extensionId, workspace, endpoint, ...registration }, event =>
      events.push(event),
    )
    connections.push(connection)
    return { provider, connection, events }
  }

  it('connects once every realm of the hello manifest is built, then reports rebuilds', async () => {
    const { provider, connection, events } = connect()
    await provider.built('renderer')
    await vi.waitFor(() => expect(connection.status).toMatchObject({ manifest, built: ['renderer'] }))
    expect(connection.status.connection).toBe('connecting')

    await provider.built('main')
    await vi.waitFor(() => expect(connection.status.connection).toBe('connected'))
    await provider.built('renderer')
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'built', realm: 'renderer' }))
    expect(events.filter(event => event.type === 'built')).toHaveLength(1)
  })

  it('restarts readiness when the provider announces a new manifest', async () => {
    const { provider, connection, events } = connect()
    await provider.built('renderer')
    await provider.built('main')
    await vi.waitFor(() => expect(connection.status.connection).toBe('connected'))

    const next: PluginManifest = { renderer: './dist/renderer.js' }
    provider.update(next)
    await vi.waitFor(() => expect(connection.status).toEqual({ connection: 'connecting', manifest: next, built: [] }))
    await provider.built('renderer')
    await vi.waitFor(() => expect(connection.status.connection).toBe('connected'))
    expect(events.filter(event => event.type === 'built')).toEqual([])
  })

  it('fails a provider that serves another extension than the registration', async () => {
    const { connection } = connect({ extensionId: 'test.other' })
    await vi.waitFor(() => expect(connection.status.connection).toBe('failed'))
    expect(connection.status.error).toContain('test.clock')
  })

  it('fails a build of a realm the manifest does not declare', async () => {
    const { provider, connection } = connect()
    await vi.waitFor(() => expect(connection.status.manifest).toEqual(manifest))
    await provider.built('extensionHost')
    await vi.waitFor(() => expect(connection.status).toMatchObject({ connection: 'failed' }))
  })
})

describe('NodeDebugEndpoints', () => {
  it('keeps the inspector open while any window holds a lease', () => {
    if (inspector.url()) return // an inspector opened by the test runner is never ours to close
    const endpoints = new NodeDebugEndpoints()
    const first = endpoints.acquire('window:1', 'test.clock')
    expect(endpoints.acquire('window:2', 'test.other')).toEqual(first)

    endpoints.release('window:1', 'test.clock')
    expect(inspector.url()).toBeDefined()
    endpoints.releaseClient('window:2')
    expect(inspector.url()).toBeUndefined()
  })
})
