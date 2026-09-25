import { z } from 'zod'

// Zod compiles validators with `new Function` unless told otherwise; the workbench's Trusted Types policy forbids that.
z.config({ jitless: true })

const milliseconds = (fallback: number, description: string) =>
  z.number().int().positive().default(fallback).describe(description)

/** One `vscursed.plugins` entry configures both realms; each reads the keys it uses. */
export const Config = z.object({
  mode: z
    .enum(['eager', 'subtle'])
    .default('eager')
    .describe('`eager` shows completions as ghost text; `subtle` fetches them quietly and shows them while ⌥ is held.'),
  trigger: z
    .object({
      enabled: z.boolean().default(true).describe('Offer Supermaven completions.'),
      requireLineEnd: z
        .boolean()
        .default(false)
        .describe('Only complete when nothing but whitespace follows the caret on its line.'),
    })
    .prefault({}),
  binaryPath: z.string().min(1).optional().describe('Run this sm-agent executable instead of downloading one.'),
  homeDirectory: z
    .string()
    .min(1)
    .optional()
    .describe('HOME of sm-agent, which keeps its login and cache under `.supermaven`.'),
  extensionVersion: z.string().min(1).default('1.1.5').describe('Supermaven extension version reported to sm-agent.'),
  editorVersion: z.string().min(1).default('1.135.0').describe('VS Code version reported to sm-agent.'),
  allowGitignore: z.boolean().default(false).describe('Let sm-agent read files that .gitignore excludes.'),
  responseWindowMs: milliseconds(900, 'Quiet period after which an answer without an end marker is final.'),
  answerWindowMs: milliseconds(2000, 'Wait before the first resend of an unanswered state.'),
  retryMaxMs: milliseconds(8000, 'Longest wait between resends of an unanswered state.'),
  requestTimeoutMs: milliseconds(30_000, 'How long a connected sm-agent may take to answer.'),
  connectTimeoutMs: milliseconds(180_000, 'How long a request waits for sm-agent to connect.'),
})

export type Config = z.output<typeof Config>
