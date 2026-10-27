// POST /api/tryon   { hand: "data:image/jpeg;base64,...", design: "https://i.pinimg.com/736x/..." }
// Отдаёт { image: "data:image/png;base64,..." } — фото руки с нарисованным маникюром.
// ИИ: OpenRouter (оплата картой или криптой). Модель меняется переменной OPENROUTER_MODEL.

import { checkAccess, UA } from './_lib.js';

const MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash-image';

const PROMPT = `You are a professional nail artist doing a realistic virtual manicure try-on.
Image 1: a photo of a person's hand.
Image 2: a manicure reference photo.
Edit IMAGE 1 only: paint every visible fingernail of the hand in image 1 with exactly the manicure from image 2 — same colors, pattern, art details, finish (glossy/matte/chrome), nail shape and approximate length.
Keep everything else in image 1 identical: the same hand, skin tone, fingers, pose, rings, background, lighting, framing and resolution. Do not add or remove fingers, do not crop, do not show image 2.
The result must look like a real unedited photograph of this hand after a salon manicure.
Return only the edited image.`;

async function toDataUrl(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.pinterest.com/' } });
  if (!r.ok) throw new Error('design_fetch_failed');
  const type = r.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await r.arrayBuffer());
  return `data:${type};base64,${buf.toString('base64')}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!checkAccess(req, res)) return;

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return res.status(500).json({ error: 'no_api_key' });

  const { hand, design } = req.body || {};
  if (typeof hand !== 'string' || !hand.startsWith('data:image/')) return res.status(400).json({ error: 'bad_hand' });
  let designUrl;
  try {
    designUrl = new URL(design);
  } catch {
    return res.status(400).json({ error: 'bad_design' });
  }
  // берём картинки только с CDN Pinterest — чтобы сервер нельзя было использовать как прокси
  if (designUrl.hostname !== 'i.pinimg.com') return res.status(400).json({ error: 'bad_design_host' });

  try {
    const designData = await toDataUrl(designUrl.href);

    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'X-Title': 'Nails Try-On',
      },
      body: JSON.stringify({
        model: MODEL,
        modalities: ['image', 'text'],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: hand } },
              { type: 'image_url', image_url: { url: designData } },
            ],
          },
        ],
      }),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j?.error?.message || `openrouter_${r.status}`;
      return res.status(r.status === 402 ? 402 : 502).json({ error: r.status === 402 ? 'no_credits' : msg });
    }

    const msg = j?.choices?.[0]?.message;
    const image = msg?.images?.[0]?.image_url?.url;
    if (!image) return res.status(502).json({ error: 'no_image', details: msg?.content?.slice?.(0, 200) });

    return res.status(200).json({ image });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
