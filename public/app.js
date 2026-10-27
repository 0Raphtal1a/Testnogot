// ============================================================
//  Маникюр — идеи с Pinterest со свайпами и избранным
// ============================================================

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- IndexedDB: избранное ----------
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

// Много разных запросов — лента получается длинной и разнообразной
const DEFAULT_QUERIES = [
  'маникюр идеи', 'маникюр 2026', 'нюдовый маникюр', 'френч маникюр', 'маникюр миндаль', 'короткий маникюр',
  'осенний маникюр', 'зимний маникюр', 'маникюр с дизайном', 'хром маникюр', 'nail art design', 'aesthetic nails',
  'almond nails', 'chrome nails',
];
const DEFAULT_SOURCES = DEFAULT_QUERIES.map((value, i) => ({ id: `d${i}`, type: 'search', value }));

// у тех, кто ставил первую версию, были только 2 запроса — заменяем на новый набор
function loadSources() {
  let list = ls.get('sources', null);
  if (!list || (ls.get('sourcesV', 1) < 2 && list.every((x) => x.id === 's1' || x.id === 's2'))) list = DEFAULT_SOURCES;
  ls.set('sourcesV', 2);
  return list;
}

const state = {
  sources: loadSources(),
  seen: new Set(ls.get('seen', [])),
  queue: [],
  history: [],
  favs: [],
  cursors: new Map(), // sourceId -> закладка следующей страницы (null — страниц больше нет)
  loadingMore: false,
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
  no_pins: 'Pinterest не отдал ни одного пина',
  not_pinterest: 'Это не ссылка на Pinterest',
  bad_link: 'Не получилось разобрать ссылку',
  network: 'Нет связи с сервером',
};
// неизвестную ошибку показываем как есть — так сразу видно причину
const errText = (e) => ERRORS[e] || (e ? `Ошибка: ${String(e).slice(0, 120)}` : 'Что-то пошло не так');

// ---------- API ----------
async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    });
  } catch {
    throw new Error('network');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `http_${r.status}`);
  return j;
}

// ---------- Экраны ----------
function show(name) {
  $('#onboarding').hidden = name !== 'onboarding';
  $('#tabs').hidden = name !== 'tabs';
}
function switchTab(tab) {
  $$('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${tab}`));
  if (tab === 'favs') { state.newFavs = 0; renderBadge(); renderFavs(); }
  if (tab === 'settings') renderSettings();
}

// ---------- Лента пинов ----------
async function fetchSource(src, cursor) {
  let qs = src.type === 'search' ? `q=${encodeURIComponent(src.value)}` : `board=${encodeURIComponent(src.value)}`;
  if (cursor) qs += `&cursor=${encodeURIComponent(cursor)}`;
  const r = await api(`/api/pins?${qs}`);
  state.cursors.set(src.id, r.cursor || null);
  return r.pins || [];
}

// Подгрузка следующих страниц, когда в колоде остаётся мало карточек
async function loadMore() {
  if (state.loadingMore) return;
  const ready = shuffle(state.sources.filter((s) => state.cursors.get(s.id)));
  if (!ready.length) return;
  state.loadingMore = true;
  try {
    const batch = ready.slice(0, 4);
    const results = await Promise.allSettled(batch.map((s) => fetchSource(s, state.cursors.get(s.id))));
    batch.forEach((s, i) => results[i].status === 'rejected' && state.cursors.set(s.id, null));
    const pins = interleave(results.filter((r) => r.status === 'fulfilled').map((r) => r.value));
    const have = new Set(state.queue.map((p) => p.id));
    state.queue.push(...pins.filter((p) => pinOk(p, have) && have.add(p.id)));
  } finally {
    state.loadingMore = false;
  }
  renderDeck();
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
  state.cursors.clear();
  const results = await Promise.allSettled(state.sources.map((src) => fetchSource(src)));
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

// ---------- Колода ----------
const cardEls = new Map();

function cardHTML(pin) {
  return `
    <img class="main" src="${esc(pin.image)}" alt="" draggable="false" referrerpolicy="no-referrer" />
    <div class="stamp like"><svg><use href="#i-heart"/></svg></div>
    <div class="stamp nope"><svg><use href="#i-x"/></svg></div>
    <div class="meta">
      <div class="meta-text">
        <div class="meta-cap">Нажми — показать целиком</div>
        <div class="meta-title">${esc(pin.title || 'Идея маникюра')}</div>
      </div>
    </div>`;
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
  });

  if (state.queue.length < 15) loadMore();
  const empty = !state.queue.length && $('#deckLoading').hidden && !state.loadingMore;
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
  if (!el || el.dataset.depth !== '0') return;
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
  if (!moved) toggleFit(el);
}
deckEl.addEventListener('pointerup', endDrag);
deckEl.addEventListener('pointercancel', endDrag);

// тап по карточке: фото целиком (без обрезки) ↔ на весь экран
function toggleFit(el) {
  const fit = el.classList.toggle('fit');
  $('.meta-cap', el).textContent = fit ? 'Нажми — вернуть' : 'Нажми — показать целиком';
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
  const fav = { id: pin.id, pin, ts: Date.now() };
  state.favs.unshift(fav);
  await db.put('favs', fav);
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
        <img src="${esc(f.pin.image)}" alt="" referrerpolicy="no-referrer" loading="lazy" />
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
let viewerFav = null;
function openViewer(fav) {
  viewerFav = fav;
  const img = $('#viewerImg');
  img.referrerPolicy = 'no-referrer';
  img.src = fav.pin.image;
  $('#viewer').hidden = false;
}

// делимся самой картинкой (через наш сервер — Pinterest не даёт браузеру читать картинки), иначе ссылкой
async function shareFav() {
  const f = viewerFav;
  try {
    const r = await fetch(`/api/img?url=${encodeURIComponent(f.pin.image)}`);
    if (r.ok) {
      const blob = await r.blob();
      const file = new File([blob], 'manicure.jpg', { type: blob.type || 'image/jpeg' });
      if (navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file] });
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

function renderSettings() {
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
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

$('#sourcesList').addEventListener('click', (e) => {
  const id = e.target.closest('[data-del]')?.dataset.del;
  if (!id) return;
  state.sources = state.sources.filter((s) => s.id !== id);
  state.cursors.delete(id);
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
    case 'start':
      ls.set('welcomed', true);
      show('tabs');
      return loadFeed();
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
  }
});

// ---------- Старт ----------
(async function init() {
  navigator.storage?.persist?.().catch(() => {});
  try {
    state.favs = ((await db.all('favs')) || []).sort((a, b) => b.ts - a.ts);
  } catch {
    /* приватный режим Safari — работаем без сохранения */
  }
  renderFavs();
  if (!ls.get('welcomed', false)) return show('onboarding');
  show('tabs');
  loadFeed();
})();
