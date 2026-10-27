// GET /api/pins?board=<ссылка на доску/профиль/пин>  или  /api/pins?q=<поисковая фраза>
// Возвращает { pins: [{ id, image, link, title }] }
// Pinterest не даёт открытого API, поэтому пробуем по очереди несколько публичных способов.

import { fetchJson, fetchText, upsize, pinIdFromImage, decodeEntities } from './_lib.js';

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

// ---------- внутренний API Pinterest (тот же, что у сайта) с постраничной подгрузкой ----------
const RES_HEADERS = { 'X-Requested-With': 'XMLHttpRequest', 'X-Pinterest-AppState': 'active' };

function mapResourcePin(p) {
  const img = p?.images?.['736x']?.url || p?.images?.orig?.url || p?.images?.['474x']?.url;
  if (!img || !p.id || p.type === 'story' || p.videos) return null;
  return {
    id: String(p.id),
    image: upsize(img),
    link: `https://www.pinterest.com/pin/${p.id}/`,
    title: (p.grid_title || p.title || p.description || '').trim().slice(0, 140),
  };
}

async function resourcePage(resource, sourceUrl, options) {
  const data = JSON.stringify({ options, context: {} });
  const j = await fetchJson(
    `https://www.pinterest.com/resource/${resource}/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(data)}`,
    RES_HEADERS,
  );
  const d = j?.resource_response?.data;
  const list = Array.isArray(d) ? d : d?.results || [];
  const next = j?.resource_response?.bookmark || j?.resource?.options?.bookmarks?.[0] || null;
  return { pins: list.map(mapResourcePin).filter(Boolean), next: next && next !== '-end-' ? next : null };
}

// Собираем несколько страниц за один вызов, чтобы лента сразу была длинной
async function collect(fetchPage, startBookmark, pages = 3) {
  const out = [];
  const seen = new Set();
  let bm = startBookmark || null;
  for (let i = 0; i < pages; i++) {
    let page;
    try {
      page = await fetchPage(bm);
    } catch (e) {
      if (!out.length && i === 0) throw e;
      break;
    }
    for (const p of page.pins) if (!seen.has(p.id)) (seen.add(p.id), out.push(p));
    bm = page.next;
    if (!bm) break;
  }
  return { pins: out, cursor: bm };
}

async function search(q, cursor) {
  const src = `/search/pins/?q=${encodeURIComponent(q)}&rs=typed`;
  try {
    const r = await collect(
      (bm) => resourcePage('BaseSearchResource', src, { query: q, scope: 'pins', page_size: 50, ...(bm ? { bookmarks: [bm] } : {}) }),
      cursor,
    );
    if (r.pins.length) return r;
  } catch {
    /* запасной способ ниже */
  }
  if (cursor) return { pins: [], cursor: null };
  return { pins: await viaHtml(`https://www.pinterest.com/search/pins/?q=${encodeURIComponent(q)}`), cursor: null };
}

// Доска: первая страница через виджет (он же даёт id доски), дальше — постранично через BoardFeedResource
async function board(user, slug, cursor) {
  const src = `/${user}/${slug}/`;
  if (cursor) {
    const [boardId, bm] = cursor.split('|');
    const r = await collect((b) => resourcePage('BoardFeedResource', src, { board_id: boardId, page_size: 50, bookmarks: [b] }), bm);
    return { pins: r.pins, cursor: r.cursor ? `${boardId}|${r.cursor}` : null };
  }
  let boardId = null;
  let first = [];
  try {
    const j = await fetchJson(`${WIDGETS}/boards/${encodeURIComponent(user)}/${encodeURIComponent(slug)}/pins/`);
    boardId = j?.data?.board?.id || null;
    first = (j?.data?.pins || []).map(mapWidgetPin).filter(Boolean);
  } catch {
    /* ниже запасные способы */
  }
  if (boardId) {
    try {
      const r = await collect((b) => resourcePage('BoardFeedResource', src, { board_id: boardId, page_size: 50, ...(b ? { bookmarks: [b] } : {}) }));
      if (r.pins.length >= first.length) return { pins: r.pins, cursor: r.cursor ? `${boardId}|${r.cursor}` : null };
    } catch {
      /* оставляем первую страницу из виджета */
    }
  }
  if (first.length) return { pins: first, cursor: null };
  const pins = await firstWorking([() => boardViaRss(user, slug), () => viaHtml(`https://www.pinterest.com${src}`)]);
  return { pins, cursor: null };
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
  const { board: link, q } = req.query;
  const cursor = req.query.cursor ? String(req.query.cursor).slice(0, 2000) : null;

  try {
    let r;
    if (q) {
      r = await search(String(q).slice(0, 80), cursor);
    } else if (link) {
      const t = await parseLink(String(link));
      if (t.type === 'search') r = await search(t.q, cursor);
      else if (t.type === 'pin') r = { pins: await pinViaWidgets(t.id), cursor: null };
      else if (t.type === 'user')
        r = { pins: await firstWorking([() => userViaWidgets(t.user), () => viaHtml(`https://www.pinterest.com/${t.user}/`)]), cursor: null };
      else r = await board(t.user, t.board, cursor);
    } else {
      return res.status(400).json({ error: 'board_or_q_required' });
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.status(200).json({ pins: r.pins, cursor: r.cursor });
  } catch (e) {
    const code = e.message === 'not_pinterest' || e.message === 'bad_link' ? 400 : 502;
    return res.status(code).json({ error: e.message, details: e.details });
  }
}
