import type {} from '@vscursed/api'
import type { Context } from 'cordis'
import type { Config } from '../config.ts'
import type { StatusChange } from '../protocol.ts'
import { Agent } from './agent.ts'
import { ensureAgentBinary, lifetimeToken } from './binary.ts'

export { Config } from '../config.ts'

export const name = 'supermaven'
export const inject = ['bridge', 'vscode']

/** Shared-process half of Supermaven: one sm-agent per workspace, serving the editors of every window. */
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('supermaven')
  const log = {
    info: (message: string) => logger.info(message),
    warn: (message: string) => logger.warn(message),
    error: (error: unknown) => logger.error(error),
  }
  const agents = new Map<string, Promise<Agent>>()
  const statusListeners = new Set<(change: StatusChange) => unknown>()
  let binary: Promise<string> | undefined
  let active = true
  const lifetime = lifetimeToken(ctx)

  const locateBinary = () =>
    (binary ??= (
      config.binaryPath ? Promise.resolve(config.binaryPath) : ensureAgentBinary(ctx.vscode, lifetime)
    ).catch(error => {
      // The next request tries again.
      binary = undefined
      throw error
    }))

  const agentFor = (workspace: string) => {
    let agent = agents.get(workspace)
    if (agent) return agent
    agent = locateBinary().then(path => {
      if (!active) throw new Error('Supermaven is unloading')
      return new Agent(workspace, path, config, log, status => {
        for (const listener of statusListeners) listener({ workspace, status })
      })
    })
    agents.set(workspace, agent)
    agent.catch(error => {
      if (agents.get(workspace) === agent) agents.delete(workspace)
      logger.warn('cannot start sm-agent in %s: %s', workspace, error)
    })
    return agent
  }

  ctx.effect(
    () => () => {
      active = false
      for (const agent of agents.values())
        agent.then(
          agent => agent.dispose(),
          () => {},
        )
      agents.clear()
    },
    'supermaven agents',
  )

  ctx.bridge.provide('sharedProcess', 'supermaven', {
    complete: async request => (await agentFor(request.workspace)).complete(request),
    resume: async (workspace, key) => (await (await agents.get(workspace))?.resume(key)) ?? null,
    status: async workspace => (await agentFor(workspace)).status,
    restart: async () => {
      for (const agent of agents.values()) (await agent).restart()
    },
    onDidChangeStatus: listener => {
      statusListeners.add(listener)
      return { dispose: () => void statusListeners.delete(listener) }
    },
  })
}
