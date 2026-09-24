#!/usr/bin/env node
import { packageVsix } from './vsix.ts'

const [command] = process.argv.slice(2)
if (command === 'vsix') {
  console.log(`vscursed: packaged ${await packageVsix()}`)
} else {
  console.error('usage: vscursed vsix')
  process.exitCode = 1
}
