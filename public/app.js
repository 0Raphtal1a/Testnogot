// ============================================================
//  Маникюр — примерка дизайнов с Pinterest на фото руки
// ============================================================

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- IndexedDB: фото руки, готовые примерки, избранное ----------
const db = (() => {
  let dbp;
  const open = () =>
    (dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open('nails', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('kv');
        d.createObjectStore('tryons');
        d.createObjectStore('favs', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (s, k) => tx(s, 'readonly', (o) => o.get(k)),
    put: (s, v, k) => tx(s, 'readwrite', (o) => (k === undefined ? o.put(v) : o.put(v, k))),
    del: (s, k) => tx(s, 'readwrite', (o) => o.delete(k)),
    all: (s) => tx(s, 'readonly', (o) => o.getAll()),
    count: (s) => tx(s, 'readonly', (o) => o.count()),
    clear: (s) => tx(s, 'readwrite', (o) => o.clear()),
  };
})();

// ---------- localStorage: источники, просмотренное, код ----------
const ls = {
  get: (k, d) => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; }
  },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const DEFAULT_SOURCES = [
  { id: 's1', type: 'search', value: 'маникюр идеи' },
  { id: 's2', type: 'search', value: 'nail art design' },
];

const state = {
  hand: null,
  handId: null,
  pendingHand: null,
  sources: ls.get('sources', DEFAULT_SOURCES),
  seen: new Set(ls.get('seen', [])),
  queue: [],
  history: [],
  favs: [],
  gen: new Map(), // pinId -> { status, image, error, promise }
  pinCache: new Map(), // sourceId -> pins
  newFavs: 0,
};

const saveSeen = () => ls.set('seen', [...state.seen].slice(-3000));
const saveSources = () => ls.set('sources', state.sources);

// ---------- утилиты ----------
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  t.style.animation = 'none'; t.offsetHeight; t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const uid = () => Math.random().toString(36).slice(2, 10);

const ERRORS = {
  no_credits: 'На балансе OpenRouter закончились деньги',
  no_api_key: 'На Vercel не задан ключ OPENROUTER_API_KEY',
  no_image: 'ИИ не смог нарисовать этот дизайн',
  design_fetch_failed: 'Не удалось скачать картинку с Pinterest',
  no_pins: 'Pinterest не отдал ни одного пина',
  not_pinterest: 'Это не ссылка на Pinterest',
  bad_link: 'Не получилось разобрать ссылку',
  network: 'Нет связи с сервером',
  need_code: 'Нужен код доступа',
};
const errText = (e) => ERRORS[e] || 'Что-то пошло не так';

// ---------- API с кодом доступа ----------
let codePromise = null;
function askCode() {
  if (codePromise) return codePromise;
  codePromise = new Promise((resolve) => {
    const a = $('#alert'), inp = $('#codeInput');
    a.hidden = false; inp.value = ''; setTimeout(() => inp.focus(), 100);
    const done = (v) => { a.hidden = true; codePromise = null; resolve(v); };
    a.onclick = (e) => {
      const act = e.target.closest('[data-action]')?.dataset.action;
      if (act === 'code-ok') done(inp.value.trim() || null);
      if (act === 'code-cancel') done(null);
    };
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); };
  });
  return codePromise;
}

async function api(path, opts = {}, retried = false) {
  let r;
  try {
    r = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'x-access-code': ls.get('code', ''), ...(opts.headers || {}) },
    });
  } catch {
    throw new Error('network');
  }
  if (r.status === 401 && !retried) {
    const code = await askCode();
    if (!code) throw new Error('need_code');
    ls.set('code', code);
    return api(path, opts, true);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `http_${r.status}`);
  return j;
}

// ---------- Фото руки ----------
async function fileToDataUrl(file, max = 1024) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('#handFile').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  try {
    state.pendingHand = await fileToDataUrl(f);
    $('#confirmImg').src = state.pendingHand;
    show('confirm');
  } catch {
    toast('Не получилось открыть фото');
  }
});

async function confirmHand() {
  const first = !state.hand;
  state.hand = state.pendingHand;
  state.handId = uid();
  state.pendingHand = null;
  await db.put('kv', state.hand, 'hand');
  await db.put('kv', state.handId, 'handId');
  state.gen.clear();
  show('tabs');
  renderSettings();
  renderFavs();
  if (first) loadFeed();
  else { renderDeck(); toast('Фото обновлено'); }
}

// ---------- Экраны ----------
function show(name) {
  $('#onboarding').hidden = name !== 'onboarding';
  $('#confirm').hidden = name !== 'confirm';
  $('#tabs').hidden = name !== 'tabs';
}
function switchTab(tab) {
  $$('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${tab}`));
  if (tab === 'favs') { state.newFavs = 0; renderBadge(); renderFavs(); }
  if (tab === 'settings') renderSettings();
}

// ---------- Лента пинов ----------
async function fetchSource(src) {
  if (state.pinCache.has(src.id)) return state.pinCache.get(src.id);
  const qs = src.type === 'search' ? `q=${encodeURIComponent(src.value)}` : `board=${encodeURIComponent(src.value)}`;
  const { pins } = await api(`/api/pins?${qs}`);
  state.pinCache.set(src.id, pins);
  return pins;
}

// перемешиваем внутри источника и чередуем источники, чтобы лента была разнообразной
function interleave(lists) {
  const ls2 = lists.map((l) => shuffle([...l]));
  const out = [];
  for (let i = 0; ls2.some((l) => i < l.length); i++) ls2.forEach((l) => l[i] && out.push(l[i]));
  return out;
}

function pinOk(p, have) {
  return !state.seen.has(p.id) && !have.has(p.id) && !state.favs.some((f) => f.id === p.id);
}

async function loadFeed() {
  $('#deckLoading').hidden = false;
  $('#deckEmpty').hidden = true;
  $('#deckActions').style.visibility = 'hidden';
  $('#deck').innerHTML = '';
  cardEls.clear();
  const results = await Promise.allSettled(state.sources.map(fetchSource));
  const lists = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const have = new Set();
  state.queue = interleave(lists).filter((p) => pinOk(p, have) && have.add(p.id));
  $('#deckLoading').hidden = true;
  if (!lists.length && state.sources.length) {
    $('#emptyTitle').textContent = 'Pinterest не ответил';
    $('#emptyText').textContent = 'Попробуй ещё раз позже или добавь ссылку на конкретную доску.';
  } else {
    $('#emptyTitle').textContent = 'Дизайны закончились';
    $('#emptyText').textContent = 'Добавь ещё доску Pinterest или покажи заново пропущенные.';
  }
  renderDeck();
}

function appendPins(pins) {
  const have = new Set(state.queue.map((p) => p.id));
  const fresh = shuffle(pins.filter((p) => pinOk(p, have)));
  // вставляем новые пины вперемешку, начиная с 3-й позиции
  fresh.forEach((p, i) => state.queue.splice(Math.min(state.queue.length, 2 + i * 2), 0, p));
  renderDeck();
}

// ---------- Генерация примерки ----------
function genKey(pin) { return `${state.handId}|${pin.id}`; }

function ensureGen(pin) {
  const cur = state.gen.get(pin.id);
  if (cur && cur.status !== 'error') return cur.promise;
  const g = { status: 'loading' };
  g.promise = (async () => {
    try {
      const cached = await db.get('tryons', genKey(pin));
      g.image = cached || (await api('/api/tryon', { method: 'POST', body: JSON.stringify({ hand: state.hand, design: pin.image }) })).image;
      if (!cached) db.put('tryons', g.image, genKey(pin)).catch(() => {});
      g.status = 'done';
    } catch (e) {
      g.status = 'error';
      g.error = e.message;
      if (e.message === 'no_credits' || e.message === 'no_api_key') toast(errText(e.message));
    }
    updateCard(pin);
    onGenDone(pin, g);
    return g;
  })();
  state.gen.set(pin.id, g);
  return g.promise;
}

async function onGenDone(pin, g) {
  if (g.status !== 'done') return;
  const fav = state.favs.find((f) => f.id === pin.id);
  if (fav && !fav.tryon) {
    fav.tryon = g.image;
    await db.put('favs', fav);
    if ($('#tab-favs').classList.contains('active')) renderFavs();
    if (viewerFav?.id === fav.id) setViewerSeg(viewerSeg);
  }
}

// ---------- Колода ----------
const cardEls = new Map();

function cardHTML(pin) {
  return `
    <img class="main" alt="" draggable="false" />
    <div class="painting" hidden><img alt="" draggable="false" /></div>
    <div class="status" hidden></div>
    <div class="stamp like"><svg><use href="#i-heart"/></svg></div>
    <div class="stamp nope"><svg><use href="#i-x"/></svg></div>
    <div class="meta">
      <div class="ref"><img src="${pin.image}" alt="" draggable="false" referrerpolicy="no-referrer" /></div>
      <div class="meta-text">
        <div class="meta-cap">Нажми — покажу оригинал</div>
        <div class="meta-title"></div>
      </div>
    </div>`;
}

function updateCard(pin) {
  const el = cardEls.get(pin.id);
  if (!el) return;
  const g = state.gen.get(pin.id);
  const main = $('img.main', el), painting = $('.painting', el), status = $('.status', el);
  const showPin = el.classList.contains('show-pin');
  $('.meta-title', el).textContent = pin.title || 'Идея маникюра';
  $('.meta-cap', el).textContent = showPin ? 'Нажми — вернуть примерку' : 'Нажми — покажу оригинал';

  if (showPin) {
    main.hidden = false; painting.hidden = true; main.referrerPolicy = 'no-referrer';
    if (main.src !== pin.image) main.src = pin.image;
    status.hidden = false; status.className = 'status'; status.textContent = 'Оригинал с Pinterest';
    return;
  }
  if (g?.status === 'done') {
    painting.hidden = true; main.hidden = false;
    if (main.src !== g.image) main.src = g.image;
    status.hidden = true;
  } else if (g?.status === 'error') {
    painting.hidden = true; main.hidden = false; main.referrerPolicy = 'no-referrer';
    if (main.src !== pin.image) main.src = pin.image;
    status.hidden = false; status.className = 'status error';
    status.innerHTML = `${errText(g.error)} · <button data-retry>Повторить</button>`;
  } else {
    main.hidden = true; painting.hidden = false;
    $('img', painting).src = state.hand;
    status.hidden = false; status.className = 'status';
    status.innerHTML = '<span class="spinner"></span>Примеряю…';
  }
}

function renderDeck() {
  const deck = $('#deck');
  const visible = state.queue.slice(0, 3);
  const ids = new Set(visible.map((p) => p.id));
  for (const [id, el] of cardEls) if (!ids.has(id) && !el.classList.contains('leaving')) { el.remove(); cardEls.delete(id); }

  visible.forEach((pin, depth) => {
    let el = cardEls.get(pin.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'card';
      el.innerHTML = cardHTML(pin);
      cardEls.set(pin.id, el);
      deck.prepend(el);
    }
    el.dataset.depth = depth;
    el.style.zIndex = 10 - depth;
    if (!el.classList.contains('dragging')) { el.style.transform = ''; el.style.opacity = ''; }
    updateCard(pin);
  });

  // генерируем верхнюю и следующую — чтобы при свайпе всё уже было готово
  visible.slice(0, 2).forEach(ensureGen);

  const empty = !state.queue.length && $('#deckLoading').hidden;
  $('#deckEmpty').hidden = !empty;
  $('#deckActions').style.visibility = state.queue.length ? 'visible' : 'hidden';
  $('[data-action="undo"]').disabled = !state.history.length;
  $('#queueInfo').textContent = state.queue.length ? `${state.queue.length} ${plural(state.queue.length, 'идея', 'идеи', 'идей')}` : '';
}

// ---------- Свайпы ----------
let drag = null;
const deckEl = $('#deck');

deckEl.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.card');
  if (!el || el.dataset.depth !== '0' || e.target.closest('[data-retry]')) return;
  drag = { el, x0: e.clientX, y0: e.clientY, t0: performance.now(), dx: 0, dy: 0, moved: false };
  el.setPointerCapture(e.pointerId);
  el.classList.add('dragging');
});

deckEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  drag.dx = e.clientX - drag.x0;
  drag.dy = e.clientY - drag.y0;
  if (Math.abs(drag.dx) + Math.abs(drag.dy) > 6) drag.moved = true;
  drag.el.style.transform = `translate(${drag.dx}px, ${drag.dy * 0.4}px) rotate(${drag.dx / 18}deg)`;
  const p = Math.min(1, Math.abs(drag.dx) / 110);
  const like = $('.stamp.like', drag.el), nope = $('.stamp.nope', drag.el);
  like.style.opacity = drag.dx > 0 ? p : 0; like.style.transform = `scale(${0.6 + 0.4 * (drag.dx > 0 ? p : 0)})`;
  nope.style.opacity = drag.dx < 0 ? p : 0; nope.style.transform = `scale(${0.6 + 0.4 * (drag.dx < 0 ? p : 0)})`;
});

function endDrag() {
  if (!drag) return;
  const { el, dx, t0, moved } = drag;
  drag = null;
  el.classList.remove('dragging');
  const v = Math.abs(dx) / (performance.now() - t0);
  if (Math.abs(dx) > 110 || (Math.abs(dx) > 40 && v > 0.6)) return decide(dx > 0 ? 1 : -1);
  el.style.transform = '';
  $$('.stamp', el).forEach((s) => { s.style.opacity = 0; s.style.transform = ''; });
  if (!moved) toggleCompare(el);
}
deckEl.addEventListener('pointerup', endDrag);
deckEl.addEventListener('pointercancel', endDrag);

deckEl.addEventListener('click', (e) => {
  if (!e.target.closest('[data-retry]')) return;
  const pin = state.queue[0];
  if (pin) { state.gen.delete(pin.id); ensureGen(pin); updateCard(pin); }
});

function toggleCompare(el) {
  const pin = state.queue[0];
  if (!pin) return;
  el.classList.toggle('show-pin');
  updateCard(pin);
}

function decide(dir) {
  const pin = state.queue[0];
  if (!pin) return;
  const el = cardEls.get(pin.id);
  if (el) {
    el.classList.remove('dragging');
    el.classList.add('leaving');
    $(dir > 0 ? '.stamp.like' : '.stamp.nope', el).style.opacity = 1;
    el.style.transform = `translate(${dir * window.innerWidth * 1.4}px, 40px) rotate(${dir * 28}deg)`;
    el.style.opacity = '0';
    cardEls.delete(pin.id);
    setTimeout(() => el.remove(), 380);
  }
  state.queue.shift();
  state.seen.add(pin.id);
  saveSeen();
  state.history.push({ pin, dir });
  if (state.history.length > 30) state.history.shift();
  if (dir > 0) addFav(pin);
  renderDeck();
}

async function undo() {
  const last = state.history.pop();
  if (!last) return;
  const { pin, dir } = last;
  state.seen.delete(pin.id);
  saveSeen();
  if (dir > 0) await removeFav(pin.id, true);
  state.queue.unshift(pin);
  // карточка прилетает обратно с той стороны, куда ушла
  const el = document.createElement('div');
  el.className = 'card dragging';
  el.innerHTML = cardHTML(pin);
  el.style.transform = `translate(${dir * window.innerWidth * 1.2}px, 40px) rotate(${dir * 20}deg)`;
  cardEls.set(pin.id, el);
  $('#deck').append(el);
  renderDeck();
  el.offsetHeight; // фиксируем стартовую позицию, затем включаем анимацию
  el.classList.remove('dragging');
  el.style.transform = '';
}

// ---------- Избранное ----------
async function addFav(pin) {
  const g = state.gen.get(pin.id);
  const fav = { id: pin.id, pin, tryon: g?.status === 'done' ? g.image : null, ts: Date.now() };
  state.favs.unshift(fav);
  await db.put('favs', fav);
  if (!fav.tryon) ensureGen(pin);
  state.newFavs++;
  renderBadge();
}

async function removeFav(id, silent) {
  state.favs = state.favs.filter((f) => f.id !== id);
  await db.del('favs', id);
  if (state.newFavs > 0 && silent) state.newFavs--;
  renderBadge();
  renderFavs();
}

function renderBadge() {
  const b = $('#favBadge');
  b.hidden = !state.newFavs;
  b.textContent = state.newFavs;
}

function renderFavs() {
  const grid = $('#favGrid');
  $('#favEmpty').hidden = state.favs.length > 0;
  $('#favCount').textContent = state.favs.length ? `${state.favs.length} ${plural(state.favs.length, 'дизайн', 'дизайна', 'дизайнов')}` : '';
  grid.innerHTML = state.favs
    .map(
      (f) => `
      <button class="fav" data-fav="${f.id}" aria-label="Открыть">
        <img src="${f.tryon || f.pin.image}" alt="" referrerpolicy="no-referrer" loading="lazy" />
        ${f.tryon ? `<span class="fav-ref"><img src="${f.pin.image}" alt="" referrerpolicy="no-referrer" loading="lazy" /></span>` : '<span class="fav-wait"><span class="spinner"></span></span>'}
      </button>`,
    )
    .join('');
}

$('#favGrid').addEventListener('click', (e) => {
  const id = e.target.closest('[data-fav]')?.dataset.fav;
  const fav = state.favs.find((f) => f.id === id);
  if (fav) openViewer(fav);
});

// ---------- Просмотр ----------
let viewerFav = null, viewerSeg = 'tryon';
function openViewer(fav) {
  viewerFav = fav;
  $('#viewer').hidden = false;
  setViewerSeg(fav.tryon ? 'tryon' : 'pin');
  if (!fav.tryon) ensureGen(fav.pin);
}
function setViewerSeg(seg) {
  viewerSeg = seg;
  $$('#viewerSeg .seg').forEach((b) => b.classList.toggle('active', b.dataset.seg === seg));
  const img = $('#viewerImg');
  img.referrerPolicy = 'no-referrer';
  img.src = seg === 'tryon' && viewerFav.tryon ? viewerFav.tryon : viewerFav.pin.image;
}
$('#viewerSeg').addEventListener('click', (e) => {
  const seg = e.target.closest('[data-seg]')?.dataset.seg;
  if (!seg) return;
  if (seg === 'tryon' && !viewerFav.tryon) return toast('Примерка ещё рисуется');
  setViewerSeg(seg);
});

async function shareFav() {
  const f = viewerFav;
  try {
    if (viewerSeg === 'tryon' && f.tryon) {
      const blob = await (await fetch(f.tryon)).blob();
      const file = new File([blob], 'manicure.png', { type: blob.type || 'image/png' });
      if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], text: f.pin.link });
    }
    if (navigator.share) return await navigator.share({ url: f.pin.link });
    await navigator.clipboard.writeText(f.pin.link);
    toast('Ссылка скопирована');
  } catch (e) {
    if (e.name !== 'AbortError') toast('Не получилось поделиться');
  }
}

// ---------- Настройки ----------
function sourceLabel(s) {
  if (s.type === 'search') return { title: s.value, sub: 'Поиск в Pinterest' };
  try {
    const u = new URL(/^https?:/.test(s.value) ? s.value : 'https://' + s.value);
    const seg = u.pathname.split('/').filter(Boolean);
    if (/pin\.it/.test(u.hostname)) return { title: 'Доска Pinterest', sub: s.value };
    if (seg[0] === 'pin') return { title: 'Пин', sub: s.value };
    const name = decodeURIComponent(seg[1] || seg[0] || 'Доска').replace(/[-_]+/g, ' ');
    return { title: name[0].toUpperCase() + name.slice(1), sub: seg[0] ? `@${seg[0]}` : s.value };
  } catch {
    return { title: 'Доска Pinterest', sub: s.value };
  }
}

async function renderSettings() {
  $('#handThumb').src = state.hand || '';
  $('#sourcesList').innerHTML =
    state.sources
      .map((s) => {
        const l = sourceLabel(s);
        return `<div class="row">
          <span class="row-ic ${s.type}"><svg><use href="#i-${s.type === 'search' ? 'search' : 'board'}"/></svg></span>
          <span class="row-main"><span class="row-label">${esc(l.title)}</span><span class="row-sub">${esc(l.sub)}</span></span>
          <button class="row-del" data-del="${s.id}" aria-label="Удалить источник"><svg><use href="#i-trash"/></svg></button>
        </div>`;
      })
      .join('') +
    `<button class="row" data-action="add-source">
      <span class="row-ic add"><svg><use href="#i-plus"/></svg></span>
      <span class="row-main"><span class="row-label accent">Добавить доску или поиск</span></span>
    </button>`;
  const n = await db.count('tryons').catch(() => 0);
  $('#cacheInfo').textContent = n ? `${n} ${plural(n, 'готовая', 'готовые', 'готовых')} — повторно не оплачиваются` : 'Пока нет';
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

$('#sourcesList').addEventListener('click', (e) => {
  const id = e.target.closest('[data-del]')?.dataset.del;
  if (!id) return;
  state.sources = state.sources.filter((s) => s.id !== id);
  state.pinCache.delete(id);
  saveSources();
  renderSettings();
  toast('Источник удалён');
});

// ---------- Шит «Новый источник» ----------
let sheetType = 'board';
function openSheet() {
  $('#sheet').hidden = false;
  $('#sheetBackdrop').hidden = false;
  setSheetType('board');
  $('#sourceInput').value = '';
  setTimeout(() => $('#sourceInput').focus(), 350);
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheetBackdrop').hidden = true;
  $('#sourceInput').blur();
}
function setSheetType(t) {
  sheetType = t;
  $$('#sourceSeg .seg').forEach((b) => b.classList.toggle('active', b.dataset.seg === t));
  const inp = $('#sourceInput');
  inp.placeholder = t === 'board' ? 'https://pin.it/… или pinterest.com/…' : 'Например: френч с блёстками';
  inp.inputMode = t === 'board' ? 'url' : 'text';
  $('#fieldIcon use').setAttribute('href', t === 'board' ? '#i-board' : '#i-search');
  $('#sheetHint').textContent = t === 'board'
    ? 'В Pinterest открой доску → «Поделиться» → «Копировать ссылку».'
    : 'Пиши так же, как искала бы в самом Pinterest.';
  $('#searchChips').hidden = t !== 'search';
}
$('#sourceSeg').addEventListener('click', (e) => { const s = e.target.closest('[data-seg]')?.dataset.seg; if (s) setSheetType(s); });
$('#searchChips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) { $('#sourceInput').value = c.textContent; } });
$('#sheetBackdrop').addEventListener('click', closeSheet);
$('#sourceInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSource(); });

async function saveSource() {
  const raw = $('#sourceInput').value.trim();
  if (!raw) return;
  let value = raw;
  if (sheetType === 'board') {
    // из текста «Посмотри мою доску https://pin.it/xyz» вытаскиваем ссылку
    value = raw.match(/https?:\/\/\S+/)?.[0] || raw;
  }
  const src = { id: uid(), type: sheetType, value };
  const btn = $('#sheetSave');
  btn.disabled = true; btn.textContent = 'Проверяю…';
  try {
    const pins = await fetchSource(src);
    if (!pins.length) throw new Error('no_pins');
    state.sources.push(src);
    saveSources();
    closeSheet();
    renderSettings();
    appendPins(pins);
    toast(`Добавлено ${pins.length} ${plural(pins.length, 'идея', 'идеи', 'идей')}`);
  } catch (e) {
    toast(errText(e.message));
  } finally {
    btn.disabled = false; btn.textContent = 'Добавить';
  }
}

// ---------- Общий обработчик действий ----------
document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) return switchTab(tabBtn.dataset.tab);
  const act = e.target.closest('[data-action]')?.dataset.action;
  switch (act) {
    case 'pick-hand': return $('#handFile').click();
    case 'confirm-hand': return confirmHand();
    case 'like': return decide(1);
    case 'nope': return decide(-1);
    case 'undo': return undo();
    case 'open-pin': return state.queue[0] && window.open(state.queue[0].link, '_blank');
    case 'go-swipe': return switchTab('swipe');
    case 'add-source': return openSheet();
    case 'close-sheet': return closeSheet();
    case 'save-source': return saveSource();
    case 'close-viewer': $('#viewer').hidden = true; viewerFav = null; return;
    case 'share-fav': return shareFav();
    case 'open-fav-pin': return window.open(viewerFav.pin.link, '_blank');
    case 'delete-fav':
      await removeFav(viewerFav.id);
      $('#viewer').hidden = true; viewerFav = null;
      return toast('Удалено из избранного');
    case 'reset-seen':
      state.seen.clear(); saveSeen(); state.history = [];
      switchTab('swipe');
      return loadFeed();
    case 'clear-cache':
      await db.clear('tryons'); state.gen.clear();
      renderSettings(); renderDeck();
      return toast('Готовые примерки удалены');
  }
});

// ---------- Старт ----------
(async function init() {
  navigator.storage?.persist?.().catch(() => {});
  try {
    state.hand = await db.get('kv', 'hand');
    state.handId = await db.get('kv', 'handId');
    state.favs = ((await db.all('favs')) || []).sort((a, b) => b.ts - a.ts);
  } catch {
    /* приватный режим Safari — работаем без сохранения */
  }
  if (!state.hand) return show('onboarding');
  show('tabs');
  renderFavs();
  loadFeed();
})();
