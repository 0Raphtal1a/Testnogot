// GET /api/pins?board=<ссылка на доску/профиль/пин>  или  /api/pins?q=<поисковая фраза>
// Возвращает { pins: [{ id, image, link, title }] }
// Pinterest не даёт открытого API, поэтому пробуем по очереди несколько публичных способов.

import { checkAccess, fetchJson, fetchText, upsize, pinIdFromImage, decodeEntities } from './_lib.js';

const WIDGETS = 'https://widgets.pinterest.com/v3/pidgets';

function mapWidgetPin(p) {
  const img = p.images?.['564x']?.url || p.images?.['237x']?.url || p.images?.orig?.url;
  if (!img) return null;
  return {
    id: String(p.id),
    image: upsize(img),
    link: `https://www.pinterest.com/pin/${p.id}/`,
    title: (p.description || p.title || '').trim().slice(0, 140),
  };
}

// --- разбор ссылки --------------------------------------------------------
async function parseLink(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  let u = new URL(url);

  // короткие ссылки pin.it раскрываем через редирект
  if (/(^|\.)pin\.it$/i.test(u.hostname)) {
    const { finalUrl } = await fetchText(u.href);
    u = new URL(finalUrl);
  }
  if (!/pinterest\./i.test(u.hostname)) throw new Error('not_pinterest');

  const seg = u.pathname.split('/').filter(Boolean).filter((s) => s !== '_' && !s.startsWith('?'));
  if (seg[0] === 'pin' && seg[1]) return { type: 'pin', id: seg[1].replace(/\D/g, '') };
  if (seg[0] === 'search') {
    return { type: 'search', q: u.searchParams.get('q') || '' };
  }
  if (seg.length >= 2) return { type: 'board', user: seg[0], board: seg[1] };
  if (seg.length === 1) return { type: 'user', user: seg[0] };
  throw new Error('bad_link');
}

// --- источники ------------------------------------------------------------
async function boardViaWidgets(user, board) {
  const j = await fetchJson(`${WIDGETS}/boards/${encodeURIComponent(user)}/${encodeURIComponent(board)}/pins/`);
  return (j?.data?.pins || []).map(mapWidgetPin).filter(Boolean);
}

async function userViaWidgets(user) {
  const j = await fetchJson(`${WIDGETS}/users/${encodeURIComponent(user)}/pins/`);
  return (j?.data?.pins || []).map(mapWidgetPin).filter(Boolean);
}

async function pinViaWidgets(id) {
  const j = await fetchJson(`${WIDGETS}/pins/info/?pin_ids=${id}`);
  return (j?.data || []).map(mapWidgetPin).filter(Boolean);
}

async function boardViaRss(user, board) {
  const { text } = await fetchText(`https://www.pinterest.com/${user}/${board}.rss`);
  const items = text.split('<item>').slice(1);
  return items
    .map((it) => {
      const img = decodeEntities(it).match(/https:\/\/i\.pinimg\.com\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp)/i)?.[0];
      if (!img) return null;
      const link = it.match(/<link>([^<]+)<\/link>/)?.[1] || '';
      const title = decodeEntities(it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || '');
      const id = link.match(/\/pin\/(\d+)/)?.[1] || pinIdFromImage(img);
      return { id, image: upsize(img), link: link || img, title: title.trim().slice(0, 140) };
    })
    .filter(Boolean);
}

async function viaHtml(pageUrl) {
  const { text } = await fetchText(pageUrl);
  const found = text.match(/https:\/\/i\.pinimg\.com\/(?:\d+x\d*|originals)\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{32}\.(?:jpg|jpeg|png|webp)/gi) || [];
  const seen = new Set();
  const out = [];
  for (const img of found) {
    const id = pinIdFromImage(img);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, image: upsize(img), link: pageUrl, title: '' });
  }
  return out;
}

async function search(q) {
  const data = JSON.stringify({ options: { query: q, scope: 'pins', page_size: 50 }, context: {} });
  const src = `/search/pins/?q=${encodeURIComponent(q)}`;
  try {
    const j = await fetchJson(
      `https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=${encodeURIComponent(src)}&data=${encodeURIComponent(data)}`,
      { 'X-Requested-With': 'XMLHttpRequest', 'X-Pinterest-AppState': 'active' },
    );
    const results = j?.resource_response?.data?.results || [];
    const pins = results
      .map((p) => {
        const img = p.images?.['736x']?.url || p.images?.orig?.url || p.images?.['474x']?.url;
        if (!img || !p.id) return null;
        return {
          id: String(p.id),
          image: upsize(img),
          link: `https://www.pinterest.com/pin/${p.id}/`,
          title: (p.grid_title || p.description || '').trim().slice(0, 140),
        };
      })
      .filter(Boolean);
    if (pins.length) return pins;
  } catch (e) {
    /* пробуем запасной способ ниже */
  }
  return viaHtml(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(q)}`);
}

// пробуем способы по очереди, пока какой-то не вернёт пины
async function firstWorking(tries) {
  const errors = [];
  for (const t of tries) {
    try {
      const pins = await t();
      if (pins.length) return pins;
    } catch (e) {
      errors.push(e.message);
    }
  }
  const err = new Error('no_pins');
  err.details = errors;
  throw err;
}

export default async function handler(req, res) {
  if (!checkAccess(req, res)) return;
  const { board, q } = req.query;

  try {
    let pins;
    if (q) {
      pins = await search(String(q).slice(0, 80));
    } else if (board) {
      const t = await parseLink(String(board));
      if (t.type === 'search') pins = await search(t.q);
      else if (t.type === 'pin') pins = await pinViaWidgets(t.id);
      else if (t.type === 'user')
        pins = await firstWorking([() => userViaWidgets(t.user), () => viaHtml(`https://www.pinterest.com/${t.user}/`)]);
      else
        pins = await firstWorking([
          () => boardViaWidgets(t.user, t.board),
          () => boardViaRss(t.user, t.board),
          () => viaHtml(`https://www.pinterest.com/${t.user}/${t.board}/`),
        ]);
    } else {
      return res.status(400).json({ error: 'board_or_q_required' });
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ pins });
  } catch (e) {
    const code = e.message === 'not_pinterest' || e.message === 'bad_link' ? 400 : 502;
    return res.status(code).json({ error: e.message, details: e.details });
  }
}
