import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Native tsconfig `paths` resolution, so `@/*` works without a plugin.
  resolve: { tsconfigPaths: true },
  test: {
    // 'node', not 'jsdom': this is pure Node — no components, no DOM.
    environment: 'node',
    include: ['lib/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
