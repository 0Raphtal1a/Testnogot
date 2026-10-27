// POST /api/tryon   { hand: "data:image/jpeg;base64,...", design: "https://i.pinimg.com/736x/...", aspect: 0.75 }
// Отдаёт { image: "data:image/...;base64,..." } — фото руки с нарисованным маникюром.
//
// Два режима (выбирается переменными окружения):
//  1) IMAGE_API_KEY задан → OpenAI-совместимый Images API (/images/edits), напр. moduleapi.pro + gpt-image-2.5
//  2) иначе OPENROUTER_API_KEY → OpenRouter + Gemini Flash Image

import { checkAccess, UA, PROMPT } from './_lib.js';

// fetch с понятной ошибкой: какой шаг и какой сетевой код (ENOTFOUND, ECONNRESET, таймаут…)
async function step(label, url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    const c = e.cause || {};
    // провайдер ИИ недоступен с этого сервера — телефон попробует обратиться к нему напрямую
    if (label.startsWith('ИИ') && /CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/.test(c.code || '')) throw new Error('provider_unreachable');
    throw new Error(`${label}: ${c.code || c.name || e.name} ${c.message || e.message}`.slice(0, 180));
  }
}



async function fetchDesign(url) {
  const r = await step('Pinterest-картинка', url, { headers: { 'User-Agent': UA, Referer: 'https://www.pinterest.com/' } });
  if (!r.ok) throw new Error('design_fetch_failed');
  const type = r.headers.get('content-type') || 'image/jpeg';
  return { type, buf: Buffer.from(await r.arrayBuffer()) };
}

function parseDataUrl(dataUrl) {
  const m = dataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!m) throw new Error('bad_hand');
  return { type: m[1], buf: Buffer.from(m[2], 'base64') };
}

const ext = (type) => (type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg');

// ---------- Режим 1: OpenAI-совместимый Images API ----------
async function viaImagesApi(hand, design, aspect) {
  const base = (process.env.IMAGE_API_BASE || 'https://moduleapi.pro/v1').replace(/\/+$/, '');
  const model = process.env.IMAGE_MODEL || 'gpt-image-2.5';
  const size = aspect < 0.85 ? '1024x1536' : aspect > 1.18 ? '1536x1024' : '1024x1024';

  const send = async (withJpeg) => {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', PROMPT);
    form.append('size', size);
    form.append('n', '1');
    // сжатый JPEG вместо PNG — ответ в разы легче и быстрее доходит до телефона
    if (withJpeg) {
      form.append('output_format', 'jpeg');
      form.append('output_compression', '85');
    }
    form.append('image[]', new Blob([hand.buf], { type: hand.type }), `hand.${ext(hand.type)}`);
    form.append('image[]', new Blob([design.buf], { type: design.type }), `design.${ext(design.type)}`);
    const r = await step(`ИИ (${new URL(base).host})`, `${base}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.IMAGE_API_KEY}` },
      body: form,
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = { error: { message: `HTTP ${r.status}: ${text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}` } }; }
    return { r, j };
  };

  let { r, j } = await send(true);
  // если провайдер не знает параметров output_format — повторяем без них
  if (r.status === 400 && /output_(format|compression)/i.test(JSON.stringify(j))) ({ r, j } = await send(false));

  if (!r.ok) {
    const msg = j?.error?.message || `images_api_${r.status}`;
    if (r.status === 402 || /quota|balance|insufficient|баланс|лимит/i.test(msg)) throw new Error('no_credits');
    if (r.status === 404) throw new Error('edits_not_supported');
    throw new Error(msg);
  }
  const item = j?.data?.[0];
  if (item?.b64_json) {
    const fmt = /^\/9j\//.test(item.b64_json) ? 'jpeg' : 'png';
    return `data:image/${fmt};base64,${item.b64_json}`;
  }
  if (item?.url) return item.url;
  throw new Error('no_image');
}

// ---------- Режим 2: OpenRouter + Gemini ----------
async function viaOpenRouter(handDataUrl, design) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'Nails Try-On',
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-image',
      modalities: ['image', 'text'],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: handDataUrl } },
            { type: 'image_url', image_url: { url: `data:${design.type};base64,${design.buf.toString('base64')}` } },
          ],
        },
      ],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 402 ? 'no_credits' : j?.error?.message || `openrouter_${r.status}`);
  const image = j?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!image) throw new Error('no_image');
  return image;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!checkAccess(req, res)) return;
  if (!process.env.IMAGE_API_KEY && !process.env.OPENROUTER_API_KEY) return res.status(500).json({ error: 'no_api_key' });

  const { hand, design, aspect } = req.body || {};
  if (typeof hand !== 'string' || !hand.startsWith('data:image/')) return res.status(400).json({ error: 'bad_hand' });
  let designUrl;
  try {
    designUrl = new URL(design);
  } catch {
    return res.status(400).json({ error: 'bad_design' });
  }
  // картинки берём только с CDN Pinterest — чтобы сервер нельзя было использовать как прокси
  if (designUrl.hostname !== 'i.pinimg.com') return res.status(400).json({ error: 'bad_design_host' });

  try {
    const designImg = await fetchDesign(designUrl.href);
    const image = process.env.IMAGE_API_KEY
      ? await viaImagesApi(parseDataUrl(hand), designImg, Number(aspect) || 0.75)
      : await viaOpenRouter(hand, designImg);
    return res.status(200).json({ image });
  } catch (e) {
    const known = ['provider_unreachable', 'no_credits', 'no_image', 'design_fetch_failed', 'edits_not_supported', 'bad_hand'];
    return res.status(e.message === 'no_credits' ? 402 : 502).json({ error: known.includes(e.message) ? e.message : e.message.slice(0, 200) });
  }
}
