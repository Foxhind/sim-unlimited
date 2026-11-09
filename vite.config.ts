import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      // Overpass returns 406 for browser User-Agents and fetch() cannot override UA.
      // Dev-only same-origin proxy injects a descriptive UA (Q42); M6 replaces with own tiles.
      '/overpass': {
        target: 'https://overpass-api.de',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/overpass/, ''),
        headers: { 'User-Agent': 'sim-unlimited/0.1 (OSM flight sim; dev)' },
      },
    },
  },
  build: { target: 'es2022' },
});