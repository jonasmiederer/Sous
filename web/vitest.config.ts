import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const domainDir = fileURLToPath(new URL('../src/domain', import.meta.url));

// Injected at build time; the release workflow bumps package.json before building.
const appVersion = (JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as { version: string }).version;
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@sous\/domain\/(.*)$/, replacement: `${domainDir}/$1` }],
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    testTimeout: 30_000,
  },
});
