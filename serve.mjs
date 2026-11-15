// Dev-only static server so the built file can be exercised over http://
// (localStorage and Web APIs need a real origin).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = normalize(join(here, 'dist'));
const assetsDir = normalize(join(here, 'assets'));
const PORT = Number(process.env.PORT || 4175);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function isInside(file, root) {
  return file === root || file.startsWith(root + sep);
}

createServer(async (req, res) => {
  let reqPath;
  try {
    reqPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (reqPath === '/') reqPath = '/index.html';

  /* Serve built files from dist/, and static assets from assets/ only */
  const candidates = [
    [normalize(join(distDir, reqPath)), distDir],
    [normalize(join(assetsDir, reqPath.replace(/^\/assets\//, '/'))), assetsDir],
  ];

  for (const [file, root] of candidates) {
    if (!isInside(file, root)) continue;
    try {
      const body = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
      res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
      return;
    } catch { /* try the next candidate */ }
  }
  res.writeHead(404).end('not found');
}).listen(PORT, '127.0.0.1', () => console.log(`serving night-light on http://127.0.0.1:${PORT}`));
