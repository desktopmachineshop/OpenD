import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Workspace packages export their TypeScript sources under the "source"
    // condition, so tests run against src/ without a build step.
    conditions: ['source'],
  },
  ssr: {
    resolve: {
      conditions: ['source'],
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
