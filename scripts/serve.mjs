import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const allowed = new Set(['index.html', 'app.js', 'styles.css', 'public-config.js', 'logo.png', 'manifest.json', 'assets/supabase.js']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
http.createServer(async (req, res) => {
  const file = new URL(req.url, 'http://localhost').pathname.replace(/^\//, '') || 'index.html';
  if (!['GET', 'HEAD'].includes(req.method) || !allowed.has(file)) { res.writeHead(404); return res.end(); }
  try { const data = await readFile(path.resolve(file)); res.writeHead(200, { 'Content-Type': types[path.extname(file)], 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : data); }
  catch { res.writeHead(404); res.end(); }
}).listen(4173, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:4173'));
