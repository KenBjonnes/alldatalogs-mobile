// serve.mjs — static server for www/ so the glue can be developed in a desktop browser (Capacitor's
// web platform runs the plugins' browser fallbacks). http://localhost:5174 — use DevTools' device
// toolbar at 916x412 to put the engine in its phone mode.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'www');
const PORT = Number(process.env.PORT || 5174);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.hpl': 'application/octet-stream' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p = normalize(decodeURIComponent(url.pathname));
    if (p === '/' || p === '\\') p = '/index.html';
    if (p.includes('..')) { res.writeHead(400); res.end(); return; }
    const abs = join(ROOT, p);
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(abs));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(PORT, '127.0.0.1', () => console.log(`www/ at http://localhost:${PORT}/`));
