// GET /api/img?url=https://i.pinimg.com/... — отдаёт картинку пина с нашего домена,
// чтобы телефон мог положить её в запрос к ИИ (браузер не даёт читать чужие картинки напрямую).

import { checkAccess, UA } from './_lib.js';

export default async function handler(req, res) {
  if (!checkAccess(req, res)) return;
  let u;
  try {
    u = new URL(String(req.query.url || ''));
  } catch {
    return res.status(400).json({ error: 'bad_url' });
  }
  if (u.hostname !== 'i.pinimg.com') return res.status(400).json({ error: 'bad_host' });
  const r = await fetch(u.href, { headers: { 'User-Agent': UA, Referer: 'https://www.pinterest.com/' } }).catch(() => null);
  if (!r || !r.ok) return res.status(502).json({ error: 'design_fetch_failed' });
  res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.status(200).send(Buffer.from(await r.arrayBuffer()));
}
