import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: { globPatterns: ['**/*.{js,css,html,svg,ico}'], runtimeCaching: [] },
      manifest: false,
      pwaAssets: false,
      includeAssets: false,
    }),
  ],
  server: { port: 4173 },
  build: { minify: true, sourcemap: false, rollupOptions: { output: { manualChunks: {} } } },
});
