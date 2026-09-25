import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    printWidth: 120,
    singleQuote: true,
    semi: false,
    arrowParens: 'avoid',
    ignorePatterns: ['upstream/vscodium/**', 'upstream/patches/**', '**/dist/**', '.vscursed/**', 'pnpm-lock.yaml'],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'plugins/*/test/**/*.test.ts'],
  },
})
