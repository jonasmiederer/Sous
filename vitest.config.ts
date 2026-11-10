import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'infra/**/*.test.ts', 'agent/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
