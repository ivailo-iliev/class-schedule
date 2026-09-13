import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        // Only the public application shell is precached. Private manifests,
        // Supabase responses, sessions and API calls never enter Workbox.
        globPatterns: [
          'index.html',
          'registerSW.js',
          'assets/**/*.{js,css}',
          'icons/**/*.{png,svg,ico}',
        ],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === self.location.origin &&
              (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')),
            handler: 'CacheFirst',
            options: {
              cacheName: 'public-assets',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      manifest: false,
      pwaAssets: false,
      includeAssets: false,
    }),
  ],
  server: { port: 4173 },
  build: { minify: true, sourcemap: false },
});
