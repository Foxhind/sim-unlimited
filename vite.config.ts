import fs from 'node:fs';
import path from 'node:path';
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

// M6 prototype: our own PMTiles (tiles/SimProfile.java) from tiles/data/out, with Range requests.
function localTiles(): Plugin {
  const root = path.resolve('tiles/data/out');
  return {
    name: 'local-tiles',
    configureServer(server) {
      server.middlewares.use('/tiles', (req, res) => {
        const file = path.join(root, decodeURIComponent((req.url ?? '/').split('?')[0]));
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const size = fs.statSync(file).size;
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        if (!m) {
          res.setHeader('Content-Length', size);
          fs.createReadStream(file).pipe(res);
          return;
        }
        const start = Number(m[1]);
        const end = Math.min(size - 1, m[2] ? Number(m[2]) : size - 1);
        if (start > end) {
          res.statusCode = 416;
          res.setHeader('Content-Range', `bytes */${size}`);
          res.end();
          return;
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(file, { start, end }).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [reportStub(), localTiles()],
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