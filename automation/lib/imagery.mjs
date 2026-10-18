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

/* ── Matching the picture to the actual story ──────────────────
   A category photo says nothing: "Bitcoin ETFs see $228M outflows" is not
   about a coin in someone's hand. The named thing in the headline — ICICI
   Bank, Michael Saylor, Deutsche Bank — makes a far better picture, so look
   for that first and fall back to the category only when there is none. */

// Capitalised words that are not the subject of anything.
const NOT_ENTITIES = new Set(('the a an and or but of for to in on at by with from as is are '
  + 'was were be it its this that these those new breaking exclusive update live watch '
  + 'why how what when where who will would could should may might can says said after '
  + 'before over under amid despite into out up down here now today yesterday report '
  + 'reports results result net profit loss revenue earnings quarter q1 q2 q3 q4 yoy '
  + 'crore lakh million billion trillion percent pct week weekly month monthly day daily '
  + 'year high low first second third last next').split(' '));

/* Title Case Headlines Capitalise Everything, which makes capitalisation
   useless as a signal. Detect that rather than extracting nonsense. */
export function isTitleCase(headline) {
  const words = String(headline).split(/\s+/).filter(w => /[a-z]/i.test(w));
  if (words.length < 4) return false;
  const caps = words.filter(w => /^[A-Z]/.test(w)).length;
  return caps / words.length > 0.65;
}

/* Named things in a headline: runs of capitalised words, longest first. */
export function entitiesFrom(headline) {
  if (isTitleCase(headline)) return [];
  const text = String(headline).replace(/[^\w\s'’&.-]/g, ' ');
  const words = text.split(/\s+/).filter(Boolean);

  const runs = [];
  let run = [];
  for (const w of words) {
    const bare = w.replace(/[.'’]+$/, '');
    const capitalised = /^[A-Z]/.test(bare) && bare.length > 1;
    const meaningful = !NOT_ENTITIES.has(bare.toLowerCase());
    if (capitalised && meaningful) run.push(bare);
    else { if (run.length) runs.push(run.join(' ')); run = []; }
  }
  if (run.length) runs.push(run.join(' '));

  return runs
    .map(r => r.replace(/['’]s$/, ''))
    .filter(r => r.length > 2)
    .sort((a, b) => b.split(' ').length - a.split(' ').length || b.length - a.length)
    .slice(0, 3);
}

/* Title-case headlines capitalise everything, so the run lengths mean nothing.
   They do still lead with their subject, though: "Deutsche Bank Is Weeks
   From..." is about Deutsche Bank. Take the opening multi-word run. */
function leadEntity(headline) {
  const words = String(headline).replace(/[^\w\s'’&.-]/g, ' ').split(/\s+/).filter(Boolean);
  const run = [];
  for (const w of words) {
    const bare = w.replace(/[.'’]+$/, '');
    if (/^[A-Z]/.test(bare) && bare.length > 1 && !NOT_ENTITIES.has(bare.toLowerCase())) run.push(bare);
    else break;
  }
  return run.length >= 2 ? run.join(' ') : null;
}

/* Queries to try, most specific first. */
export function queriesFor(headline) {
  const out = [];
  const lead = isTitleCase(headline) ? leadEntity(headline) : null;
  if (lead) out.push(lead);
  for (const e of entitiesFrom(headline)) if (!out.includes(e)) out.push(e);
  const subject = subjectFor(headline);
  if (!out.includes(subject)) out.push(subject);
  return out;
}

/* How well a result actually matches the story. Openverse gives a title and
   tags; an image whose own words overlap the headline is far more likely to
   be a picture OF the story than the biggest file the search returned. */
export function relevance(item, headline) {
  const words = new Set(String(headline).toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3));
  if (!words.size) return 0;

  const hay = [item.title || '', ...(item.tags || []).map(t => t.name || t)]
    .join(' ').toLowerCase();
  let hits = 0;
  for (const w of words) if (hay.includes(w)) hits++;
  return hits / words.size;
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

export function pickBest(results, exclude) {
  const seen = exclude instanceof Set ? exclude : new Set(exclude || []);
  const usable = (results || []).filter(isUsable).filter(r => !seen.has(r.url));
  if (!usable.length) return null;
  // Prefer the least restrictive licence, then the largest image.
  const rank = l => (l === 'cc0' ? 0 : l === 'pdm' ? 1 : 2);
  usable.sort((a, b) => rank(a.license) - rank(b.license) || (b.width || 0) - (a.width || 0));
  return usable[0];
}

async function searchOnce(q, { fetchImpl, timeoutMs, exclude }) {
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
    if (res.status === 429) return { results: [], error: 'rate limited by Openverse (429)' };
    if (!res.ok) return { results: [], error: `HTTP ${res.status}` };
    const body = await res.json();
    return { results: (body && body.results) || [], error: null };
  } catch (err) {
    return { results: [],
             error: err && err.name === 'AbortError' ? 'timed out' : String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/* Work from the most specific subject in the headline down to its category,
   and prefer a result whose own title and tags echo the story. The point is a
   picture OF the story, not a picture of its genre. */
export async function findImage(headline, { fetchImpl = fetch, timeoutMs = 12000, exclude,
                                            minRelevance = 0.12, maxQueries = 2 } = {}) {
  // Each query is an API call, and the search is rate limited. Two per story —
  // the named subject and the category — is the useful part of the list; going
  // deeper mostly spends quota to arrive at the same fallback.
  const queries = queriesFor(headline).slice(0, maxQueries);
  let fallback = null, lastError = null;

  for (const q of queries) {
    const { results, error } = await searchOnce(q, { fetchImpl, timeoutMs, exclude });
    if (error) { lastError = error; continue; }

    const best = pickBest(results, exclude);
    if (!best) continue;

    // Of the usable results, take the one that best echoes the headline.
    const seen = exclude instanceof Set ? exclude : new Set(exclude || []);
    const scored = results.filter(isUsable).filter(r => !seen.has(r.url))
      .map(r => ({ r, score: relevance(r, headline) }))
      .sort((a, b) => b.score - a.score);
    const chosen = scored[0] || { r: best, score: 0 };

    const image = {
      url: chosen.r.url, credit: creditFor(chosen.r), license: chosen.r.license,
      source: chosen.r.source, pageUrl: chosen.r.foreign_landing_url, title: chosen.r.title,
      relevance: Math.round(chosen.score * 100) / 100,
    };

    // A specific query that actually matched wins outright. Otherwise hold it
    // and try the next, less specific, query.
    if (chosen.score >= minRelevance || q === queries[queries.length - 1])
      return { image, query: q, error: null };
    if (!fallback) fallback = { image, query: q, error: null };
  }

  if (fallback) return fallback;
  return { image: null, query: queries[0],
           error: lastError || (exclude && exclude.size ? 'no unused image left' : 'nothing suitably licensed') };
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
