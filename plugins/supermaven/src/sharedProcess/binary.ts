import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VSCode } from '@vscursed/api'
import type { Context } from 'cordis'
import { z } from 'zod'
import type { VSBufferReadableStream } from 'vscode-internal/vs/base/common/buffer.js'
import type { CancellationToken } from 'vscode-internal/vs/base/common/cancellation.js'
import { IRequestService } from 'vscode-internal/vs/platform/request/common/request.js'
import { IUserDataProfilesService } from 'vscode-internal/vs/platform/userDataProfile/common/userDataProfile.js'

const Release = z.object({
  downloadUrl: z.url({
    protocol: /^https$/,
    hostname: /^(supermaven-public\.s3\.amazonaws\.com|cdn\.supermaven\.com)$/,
  }),
  version: z.number().int().nonnegative(),
  sha256Hash: z.string().regex(/^[a-f0-9]{64}$/i),
})

const platforms = ['darwin', 'linux', 'win32']
const architectures = ['arm64', 'x64']

/**
 * VS Code's cancellation in terms of the plugin's lifetime: the token is cancelled when the fiber
 * unloads, and each listener is an effect of the fiber that its subscription removes again.
 */
export function lifetimeToken(ctx: Context): CancellationToken {
  let cancelled = false
  ctx.effect(() => () => void (cancelled = true), 'supermaven download lifetime')
  return {
    get isCancellationRequested() {
      return cancelled
    },
    onCancellationRequested(listener, thisArgs) {
      let subscribed = true
      const unsubscribe = ctx.effect(
        () => () => {
          // Effects end in reverse order, so this one ends before the flag above is set.
          cancelled = true
          if (subscribed) listener.call(thisArgs, undefined)
        },
        'supermaven download cancellation',
      )
      return {
        dispose() {
          subscribed = false
          void unsubscribe()
        },
      }
    },
  }
}

async function fetchBody(vscode: VSCode, token: CancellationToken, url: string, callSite: string) {
  const { res, stream } = await vscode.get(IRequestService).request({ type: 'GET', url, callSite }, token)
  const body = await readAll(stream)
  const status = res.statusCode ?? 0
  if (status < 200 || status >= 300) throw new Error(`${url} answered with HTTP ${status}`)
  return body
}

function readAll(stream: VSBufferReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = []
  return new Promise((resolve, reject) => {
    stream.on('data', chunk => chunks.push(chunk.buffer))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

/**
 * The `sm-agent` release for this platform, kept per version in the default profile's global storage
 * and checked against the SHA-256 that Supermaven publishes with it. Requests go through VS Code's
 * request service, so they follow the proxy settings.
 */
export async function ensureAgentBinary(vscode: VSCode, token: CancellationToken): Promise<string> {
  const { platform, arch } = process
  if (!platforms.includes(platform) || !architectures.includes(arch)) {
    throw new Error(`sm-agent is not available for ${platform}-${arch}`)
  }
  const query = new URLSearchParams({ platform, arch, editor: 'vscode' })
  const metadata = await fetchBody(
    vscode,
    token,
    `https://supermaven.com/api/download-path-v2?${query}`,
    'vscursed.supermaven.release',
  )
  const release = Release.parse(JSON.parse(metadata.toString('utf8')))
  const checksum = release.sha256Hash.toLowerCase()

  const storage = vscode.get(IUserDataProfilesService).defaultProfile.globalStorageHome
  if (storage.scheme !== 'file' && storage.scheme !== 'vscode-userdata') {
    throw new Error(`sm-agent needs local storage, not ${storage.scheme}`)
  }
  const directory = join(
    storage.fsPath,
    'vscursed.supermaven',
    'sm-agent',
    String(release.version),
    `${platform}-${arch}`,
  )
  const binary = join(directory, platform === 'win32' ? 'sm-agent.exe' : 'sm-agent')
  const existing = await readFile(binary).catch(() => undefined)
  if (existing && sha256(existing) === checksum) {
    if (platform !== 'win32') await chmod(binary, 0o755)
    return binary
  }

  const body = await fetchBody(vscode, token, release.downloadUrl, 'vscursed.supermaven.download')
  if (sha256(body) !== checksum) throw new Error(`the downloaded sm-agent does not match its SHA-256 ${checksum}`)
  await mkdir(directory, { recursive: true })
  // Written aside and renamed, so that a concurrent start never runs a partial file.
  const temporary = `${binary}.${randomUUID()}`
  try {
    await writeFile(temporary, body, { mode: 0o755 })
    if (platform !== 'win32') await chmod(temporary, 0o755)
    await rename(temporary, binary)
  } finally {
    await rm(temporary, { force: true })
  }
  return binary
}
