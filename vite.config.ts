import { defineConfig, type Plugin } from 'vite';

// Q34: dev stub of our own report endpoint — logs batches, no third parties.
function reportStub(): Plugin {
  return {
    name: 'report-stub',
    configureServer(server) {
      server.middlewares.use('/api/report', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
        req.on('end', () => {
          server.config.logger.info(`[report] ${body.slice(0, 500)}`);
          res.setHeader('Content-Type', 'application/json');
          res.end('{}');
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [reportStub()],
  server: {
    port: 5173,
    proxy: {
      // Overpass returns 406 for browser User-Agents and fetch() cannot override UA.
      // Dev-only same-origin proxy injects a descriptive UA (Q42); M6 replaces with own tiles.
      '/overpass': {
        target: process.env.OVERPASS_TARGET ?? 'https://overpass-api.de',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/overpass/, ''),
        headers: { 'User-Agent': 'sim-unlimited/0.1 (OSM flight sim; dev)' },
      },
    },
  },
  build: { target: 'es2022' },
});