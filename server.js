// Сервер для VPS: раздаёт интерфейс из public/ и обрабатывает /api/* теми же функциями, что и на Vercel.
// Запуск: node --env-file=.env server.js   (порт — переменная PORT, по умолчанию 3000)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pins from './api/pins.js';
import img from './api/img.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 1024 * 1024;

const ROUTES = { '/api/pins': pins, '/api/img': img };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Добавляем в ответ методы как у Vercel: res.status().json(), res.send()
function vercelify(req, res, url) {
  req.query = Object.fromEntries(url.searchParams);
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (obj) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => (res.end(body), res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too_large'), { code: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return res.writeHead(403).end();
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.join(ROOT, 'index.html');
    const ext = path.extname(target);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(target).pipe(res);
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const handler = ROUTES[url.pathname.replace(/\/+$/, '')];
    if (!handler) return serveStatic(req, res, url);

    vercelify(req, res, url);
    try {
      if (req.method === 'POST') {
        const raw = await readBody(req);
        req.body = /json/.test(req.headers['content-type'] || '') && raw.length ? JSON.parse(raw.toString('utf8')) : {};
      }
      await handler(req, res);
    } catch (e) {
      if (!res.headersSent) res.status(e.code === 413 ? 413 : 500).json({ error: e.code === 413 ? 'http_413' : 'server_error' });
      console.error(new Date().toISOString(), url.pathname, e.message);
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Маникюр: http://127.0.0.1:${PORT}`));
