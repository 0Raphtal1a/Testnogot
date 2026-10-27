// GET /api/direct — настройки для прямого запроса к ИИ с телефона.
// Нужен, когда провайдер ИИ (например, moduleapi.pro) не пускает зарубежные серверы Vercel,
// но доступен из России. Ключ отдаётся ТОЛЬКО при верном коде доступа.

import { PROMPT } from './_lib.js';

export default function handler(req, res) {
  const code = process.env.ACCESS_CODE;
  if (!code) return res.status(403).json({ error: 'direct_needs_access_code' });
  if ((req.headers['x-access-code'] || '') !== code) return res.status(401).json({ error: 'need_code' });
  if (!process.env.IMAGE_API_KEY) return res.status(500).json({ error: 'no_api_key' });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    base: (process.env.IMAGE_API_BASE || 'https://moduleapi.pro/v1').replace(/\/+$/, ''),
    model: process.env.IMAGE_MODEL || 'gpt-image-2.5',
    key: process.env.IMAGE_API_KEY,
    prompt: PROMPT,
  });
}
