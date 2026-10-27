// Общие хелперы для серверных функций (файлы с "_" Vercel не публикует как эндпоинты)

export const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// Проверка кода доступа: если ACCESS_CODE задан в Vercel, без него API не работает
export function checkAccess(req, res) {
  const code = process.env.ACCESS_CODE;
  if (!code) return true;
  const got = req.headers['x-access-code'] || '';
  if (got === code) return true;
  res.status(401).json({ error: 'need_code' });
  return false;
}

// Все картинки пинов приводим к размеру 736px (хорошее качество, небольшой вес)
export function upsize(url) {
  return url.replace(/\/(?:\d+x\d*|originals)\//, '/736x/');
}

export function pinIdFromImage(url) {
  const m = url.match(/\/([a-f0-9]{32})\.(?:jpg|jpeg|png|webp)/i);
  return m ? m[1] : url;
}

export async function fetchText(url, extraHeaders = {}) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8', ...extraHeaders },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return { text: await r.text(), finalUrl: r.url };
}

export async function fetchJson(url, extraHeaders = {}) {
  const { text } = await fetchText(url, { Accept: 'application/json', ...extraHeaders });
  return JSON.parse(text);
}

export function decodeEntities(s = '') {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

