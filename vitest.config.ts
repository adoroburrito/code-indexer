import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      // index.ts is the CLI entry point — tested via subprocess in e2e tests
      // but cannot be instrumented by v8 coverage across process boundaries.
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/__tests__/**',
      ],
    },
  },
});
