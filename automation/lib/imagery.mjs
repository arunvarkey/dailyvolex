/* Finding a photograph for a story, legally.
 *
 * The tempting option is the outlet's own article image. It is also
 * copyright infringement: those photographs belong to Reuters, AP, Getty or
 * the publisher, and reposting them is what gets a news account struck or
 * sued. For a channel whose entire asset is credibility, that is not a
 * shortcut worth taking.
 *
 * So images come from Openverse, which indexes openly licensed work, and only
 * under licences that permit commercial use: CC0 and Public Domain Mark, which
 * require nothing, and CC-BY, which requires credit. The credit is carried all
 * the way onto the graphic — a CC-BY image without attribution is as much an
 * infringement as taking Reuters' photo.
 *
 * Share-alike (BY-SA) is deliberately excluded: it would arguably oblige the
 * finished graphic to be licensed the same way.
 */

const API = 'https://api.openverse.org/v1/images/';
const USABLE = ['cc0', 'pdm', 'by'];

/* What a headline is actually about. Named things first — they make for a far
   better picture than an abstract term. */
const SUBJECTS = [
  [/\b(federal reserve|the fed|fomc)\b/i,          'federal reserve building'],
  [/\b(sec|securities and exchange)\b/i,           'wall street exchange building'],
  [/\b(cftc|regulator|lawsuit|judge|court)\b/i,    'courthouse columns'],
  [/\b(rbi|reserve bank of india)\b/i,             'reserve bank of india mumbai'],
  [/\b(sensex|nifty|bse|nse|indian market)\b/i,    'mumbai stock exchange'],
  [/\b(bitcoin|btc)\b/i,                           'bitcoin'],
  [/\b(ethereum|eth)\b/i,                          'ethereum'],
  [/\b(solana|xrp|altcoin|token)\b/i,              'cryptocurrency'],
  [/\b(etf|fund|blackrock|vanguard)\b/i,           'stock market chart screen'],
  [/\b(oil|crude|opec)\b/i,                        'oil refinery'],
  [/\b(gold|bullion)\b/i,                          'gold bars'],
  [/\b(bank|banking|deutsche|hsbc|jpmorgan)\b/i,   'bank building facade'],
  [/\b(inflation|cpi|rates?|yield)\b/i,            'financial newspaper'],
  [/\b(earnings|revenue|profit|ipo)\b/i,           'trading floor'],
  [/\b(tariff|trade|export|import)\b/i,            'shipping containers port'],
  [/\b(mining|miner)\b/i,                          'data centre servers'],
];

export function subjectFor(headline) {
  for (const [re, query] of SUBJECTS) if (re.test(headline)) return query;
  return 'stock market trading screen';      // always something sensible
}

/* Credit line, in the form the licence expects: who made it, under what. */
export function creditFor(item) {
  const who = (item.creator || 'Unknown').toString().slice(0, 40);
  const lic = String(item.license || '').toUpperCase();
  const ver = item.license_version ? ' ' + item.license_version : '';
  if (item.license === 'cc0')  return `Photo: ${who} / CC0`;
  if (item.license === 'pdm')  return `Photo: ${who} / Public Domain`;
  return `Photo: ${who} / CC ${lic}${ver}`;
}

/* Is this safe to put on a commercial-ish account, and worth using? */
export function isUsable(item) {
  if (!item || !item.url) return false;
  if (!USABLE.includes(item.license)) return false;
  // Landscape and reasonably large: a small portrait crops badly to 4:5.
  if (item.width && item.height) {
    if (item.width < 1200) return false;
    if (item.height / item.width > 1.1) return false;
  }
  return true;
}

export function pickBest(results) {
  const usable = (results || []).filter(isUsable);
  if (!usable.length) return null;
  // Prefer the least restrictive licence, then the largest image.
  const rank = l => (l === 'cc0' ? 0 : l === 'pdm' ? 1 : 2);
  usable.sort((a, b) => rank(a.license) - rank(b.license) || (b.width || 0) - (a.width || 0));
  return usable[0];
}

export async function findImage(headline, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const q = subjectFor(headline);
  const url = `${API}?q=${encodeURIComponent(q)}`
    + `&license=${USABLE.join(',')}`
    + '&license_type=commercial,modification'
    + '&size=large&orientation=landscape&page_size=12&mature=false';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'DailyVolex/1.0 (+https://github.com/arunvarkey/dailyvolex)' },
    });
    if (!res.ok) return { image: null, query: q, error: `HTTP ${res.status}` };
    const body = await res.json();
    const best = pickBest(body && body.results);
    if (!best) return { image: null, query: q, error: 'nothing suitably licensed' };
    return {
      image: { url: best.url, credit: creditFor(best), license: best.license,
               source: best.source, pageUrl: best.foreign_landing_url, title: best.title },
      query: q, error: null,
    };
  } catch (err) {
    // No picture is a fine outcome — the generated chart takes over.
    return { image: null, query: q,
             error: err && err.name === 'AbortError' ? 'timed out' : String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/* Fetch the file itself. Refuses anything that is not actually an image, and
   anything implausibly large, since this runs unattended. */
export async function downloadImage(url, destPath, { fetchImpl = fetch, maxBytes = 12_000_000 } = {}) {
  const { writeFile } = await import('node:fs/promises');
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'DailyVolex/1.0 (+https://github.com/arunvarkey/dailyvolex)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!/^image\/(jpe?g|png|webp)/.test(type)) throw new Error(`not an image (${type || 'no type'})`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('empty file');
  if (buf.length > maxBytes) throw new Error(`too large (${(buf.length / 1048576).toFixed(1)} MB)`);

  await writeFile(destPath, buf);
  return { bytes: buf.length, type };
}
