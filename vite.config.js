import { defineConfig } from 'vite';

export default defineConfig({
  // covers.json is 905 KB; inlining it as a JS module removes a round trip
  // and keeps the grid's first paint to a single request.
  build: {
    // main.js uses top-level await to load covers.json before building the grid
    target: 'esnext',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5173, open: true },
});
