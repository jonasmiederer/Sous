import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const domainDir = fileURLToPath(new URL('../src/domain', import.meta.url));

const THEME_COLOR = '#2f6b3a';

export default defineConfig({
  resolve: {
    // Shared pure domain modules from the backend (presets, types, units).
    // Import them per module, e.g. `@sous/domain/presets`.
    alias: [{ find: /^@sous\/domain\/(.*)$/, replacement: `${domainDir}/$1` }],
  },
  server: {
    fs: { allow: ['.', domainDir] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      // public/icons is already matched by workbox.globPatterns below.
      includeManifestIcons: false,
      manifest: {
        name: 'Sous',
        short_name: 'Sous',
        description: 'Meal ideas, weekly plans, and grocery lists for your household.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f7f8f5',
        theme_color: THEME_COLOR,
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Precache the built shell and hashed assets only.
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        navigateFallback: '/index.html',
        // Never treat runtime config or API-looking paths as SPA navigations.
        navigateFallbackDenylist: [/^\/config\.json$/, /^\/api\//],
        cleanupOutdatedCaches: true,
        // Only /config.json is runtime-cached. API and Cognito traffic is
        // cross-origin and has no route here, so it is never cached.
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname === '/config.json',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'sous-config',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 1 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
});
