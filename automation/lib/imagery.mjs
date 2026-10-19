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

/* Some stories have no photographic subject at all. A market-index move is
   about a number going down; the honest illustration is the chart, and a
   photograph found by searching "Nifty" is a picture of something else — one
   run returned a close-up of gravel, because the photographer had used the
   word. For these the chart is not a fallback, it is the right answer. */
const CHART_IS_BETTER = [
  /\b(sensex|nifty|dow|nasdaq|s&p|ftse|nikkei|moex|hang seng)\b/i,
  // Not "holiday" or "today": a market holiday is about a date, and a picture
  // of the festival behind it is a better card than a chart of nothing.
  /\bstock market (crash|rally|close|open)\b/i,
  /\b(index|indices|benchmark)\b.*\b(up|down|gain|lose|rise|fall|close)\b/i,
  /\b(points?|pct|%)\b.*\b(up|down|gain|lost|rise|fall|tumble|plunge|surge|climb)\b/i,
  /\b(tumbles?|plunges?|surges?|climbs?|slips?|rallies)\b.*\b\d/i,
];

export function prefersChart(headline) {
  return CHART_IS_BETTER.some(re => re.test(String(headline)));
}

/* The last-resort query, when the headline names nothing searchable. It has
   to follow the beat: a story about a conference in India was falling back to
   "stock market trading screen", which is not a worse picture of the story so
   much as a picture of a different story. */
const FALLBACK_BY_TOPIC = {
  crypto:          'cryptocurrency',
  'markets-india': 'mumbai stock exchange',
  'markets-world': 'stock market trading screen',
  business:        'office towers business district',
  india:           'india',
  world:           'international summit flags',
  tech:            'technology data centre',
};

export function subjectFor(headline, topic) {
  for (const [re, query] of SUBJECTS) if (re.test(headline)) return query;
  return FALLBACK_BY_TOPIC[topic] || 'newspapers';
}

/* When no photograph can be used, something still has to sit behind the
   headline — and the choice is editorial, not decorative. The generated price
   chart was being used for everything, so a card reading "India to host global
   legal metrology meet" went out over a falling market line. To anyone
   scrolling, that chart IS a claim: it says the story is about markets.
   A chart belongs behind a story about money moving; everything else gets the
   neutral editorial backdrop. */
const MARKET_BEATS = new Set(['crypto', 'markets-india', 'markets-world']);
/* Deliberately the plural or financial forms only. "Leaders share a stage" and
   "the scheme funds new hospitals" are not markets stories, and a chart behind
   either would be the exact mistake this is here to prevent. */
const MONEY_IN_HEADLINE = [
  /\b(stocks?|shares|market|markets|indices|bonds?|yields|equity|equities)\b/i,
  /\b(sensex|nifty|dow|nasdaq|s&p|ftse|nikkei|bse|nse)\b/i,
  /\b(bitcoin|btc|ethereum|eth|crypto|stablecoin)\b/i,
  /\b(rupee|dollar|euro|yen|forex|currency|bullion|crude|oil prices?)\b/i,
  /\b(earnings|revenue|profits?|ipo|valuation|investors?|inflation|rate (cut|hike)s?)\b/i,
  // Deliberately NOT a bare currency figure. "India-New Zealand FTA … targets
  // double trade to $7bn by 2030" is a treaty with a target in it, and it went
  // out over a price chart; the chart has to mean market data or it means
  // nothing.
];

export function backdropFor(headline, topic) {
  if (prefersChart(headline)) return 'chart';
  if (MONEY_IN_HEADLINE.some(re => re.test(String(headline)))) return 'chart';
  if (MARKET_BEATS.has(topic)) return 'chart';
  return 'editorial';
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
  + 'year high low first second third last next '
  // Dates. "India-New Zealand FTA Effective From Oct 20" was searched as "Oct".
  + 'jan feb mar apr may jun jul aug sep sept oct nov dec january february march april '
  + 'june july august september october november december monday tuesday wednesday '
  + 'thursday friday saturday sunday '
  // Common nouns a title-case headline capitalises like a name. "Stock Market
  // Holiday On 20 Oct" was searched as "Stock Market Holiday", which found a
  // photograph of a fish market — it shares two words with the query and
  // nothing at all with the story.
  + 'stock stocks share shares market markets holiday holidays trading trade price '
  + 'prices index rate rates news deal deals meet meeting talks plan plans rule rules '
  + 'government police court man woman men women people top full big major global '
  + 'national state central public private closed open shut ahead due set').split(' '));

/* Title Case Headlines Capitalise Everything, which makes capitalisation
   useless as a signal. Detect that rather than extracting nonsense. */
export function isTitleCase(headline) {
  const words = String(headline).split(/\s+/).filter(w => /[a-z]/i.test(w));
  if (words.length < 4) return false;
  const caps = words.filter(w => /^[A-Z]/.test(w)).length;
  return caps / words.length > 0.65;
}

/* Named things in a headline: runs of capitalised words, longest first.
   `force` runs it on a Title Case headline too, where capitalisation means
   nothing — useful only once the generic words are stripped, and only when
   nothing else has produced a subject. */
export function entitiesFrom(headline, { force = false } = {}) {
  if (!force && isTitleCase(headline)) return [];
  // Keep punctuation as a boundary: "Coforge, Lalithaa Jewellery" is two
  // companies, and merging them searches for a thing that does not exist.
  const text = String(headline).replace(/[^\w\s'’&.-]/g, ' | ');
  const words = text.split(/\s+/).filter(Boolean);

  const runs = [];
  let run = [];
  for (const w of words) {
    const bare = w.replace(/[.'’]+$/, '');
    const capitalised = /^[A-Z]/.test(bare) && bare.length > 1;
    const meaningful = !NOT_ENTITIES.has(bare.toLowerCase());
    if (w !== '|' && capitalised && meaningful) run.push(bare);
    else { if (run.length) runs.push(run.join(' ')); run = []; }
  }
  if (run.length) runs.push(run.join(' '));

  return runs
    // Names are short. A five-word run is a sentence fragment, and searching
    // for it finds nothing slowly.
    .map(r => r.split(' ').slice(0, 3).join(' '))
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
    if (run.length === 3) break;          // a name, not an opening clause
  }
  // One substantial word is still a usable subject — "India To Host Global
  // Legal Metrology Meet" yielded nothing, and fell back to a finance query.
  if (run.length === 1 && run[0].length > 3) return run[0];
  return run.length >= 2 ? run.join(' ') : null;
}

/* Legal and criminal matters, where searching a name is the whole danger.
   "Neha Bora moves Delhi High Court against peace bond notice" would have been
   searched as "Neha Bora" — and an openly licensed photograph of somebody
   else of that name, put under that headline, says a stranger is the subject
   of a legal proceeding. On these stories the generic subject is the only
   honest option. */
const LEGAL_MATTER = /\b(court|courts|lawsuit|sues?|sued|suing|charged|charges|arrest(ed)?|convict(ed|ion)?|acquitt\w+|bail|verdict|sentenc(ed|ing)|jail(ed)?|accused|alleged\w*|fir|summons|tribunal|plea|petition|injunction|indict\w+|prosecut\w+)\b/i;

/* Queries to try, most specific first. */
export function queriesFor(headline, topic) {
  if (LEGAL_MATTER.test(String(headline))) return [subjectFor(headline, topic)];

  const out = [];
  const lead = isTitleCase(headline) ? leadEntity(headline) : null;
  if (lead) out.push(lead);
  for (const e of entitiesFrom(headline)) if (!out.includes(e)) out.push(e);
  // A title-case headline whose opening words are all generic yields nothing
  // above, and then the only query left is the category — which is how a
  // Dussehra market-holiday story came to be searched as "stock market". What
  // is distinctive is still in there; it is just not at the front.
  if (!out.length) for (const e of entitiesFrom(headline, { force: true })) out.push(e);
  const subject = subjectFor(headline, topic);
  if (!out.includes(subject)) out.push(subject);
  return out;
}

/* How well a result actually matches the story. Openverse gives a title and
   tags; an image whose own words overlap the headline is far more likely to
   be a picture OF the story than the biggest file the search returned.
 *
 * Only distinctive words count. A photograph of a Taiwanese fish shop was put
 * behind "Stock Market Holiday On 20 Oct: NSE, BSE Closed For Dussehra?"
 * because its tags said "market" and "holiday" — it shared two words with the
 * headline and nothing whatever with the story. An overlap made entirely of
 * words like those is not an overlap. */
export function relevance(item, headline) {
  const words = new Set(String(headline).toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !NOT_ENTITIES.has(w)));
  if (!words.size) return 0;

  const hay = [item.title || '', ...(item.tags || []).map(t => t.name || t)]
    .join(' ').toLowerCase();
  let hits = 0;
  for (const w of words) if (hay.includes(w)) hits++;
  return hits / words.size;
}

/* Credit line, in the form the licence expects: who made it, under what.
 *
 * "File photo", not "Photo", and not as hedging. Nothing in an openly licensed
 * library is a picture of what was reported this morning, and a card can imply
 * otherwise without saying a word: a World Food Programme aid photograph ran
 * under a headline about Gaza, so an identifiable woman photographed somewhere
 * else entirely was presented as being there. Every newsroom labels a library
 * image, and this one has to as well. */
export function creditFor(item) {
  const who = (item.creator || 'Unknown').toString().slice(0, 40);
  const lic = String(item.license || '').toUpperCase();
  const ver = item.license_version ? ' ' + item.license_version : '';
  if (item.license === 'cc0')  return `File photo: ${who} / CC0`;
  if (item.license === 'pdm')  return `File photo: ${who} / Public Domain`;
  return `File photo: ${who} / CC ${lic}${ver}`;
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

/* Stories where a library photograph is not an illustration but a claim about
   real people.
 *
 * A World Food Programme aid photograph ran under a headline about cutting aid
 * to Gaza. The woman in it was photographed somewhere else entirely, and the
 * card presented her as being there. The credit line helps, but it is small
 * and it is read after the picture. There is no openly licensed photograph of
 * what happened this morning, and on a story about people in harm the gap
 * between "a picture of this kind of thing" and "a picture of this" is a gap
 * nobody should be invited to fall into. These get the editorial backdrop. */
const PEOPLE_IN_HARM = [
  /\b(war|warfare|conflict|ceasefire|truce|airstrike|air strikes?|shelling|bombing|bombed)\b/i,
  /\b(killed|dead|deaths?|casualties|wounded|injured|massacre|genocide|atrocit(y|ies))\b/i,
  /\b(famine|starvation|malnutrition|refugees?|displaced|evacuat\w+|humanitarian)\b/i,
  // Relief work and the bodies that do it. "Funding shortages force the World
  // Food Programme to cut aid to Gaza" named none of the words above, and that
  // is the headline the misplaced photograph ran under.
  /\b(aid|relief|hunger|siege|blockade|shelters?|camps?|asylum)\b/i,
  /\b(world food programme|wfp|unhcr|unicef|red cross|red crescent|oxfam|unrwa|m[ée]decins)\b/i,
  /\b(earthquake|quake|tsunami|flood(s|ing|ed)?|cyclone|hurricane|typhoon|wildfires?|landslide)\b/i,
  /\b(shooting|gunman|hostages?|abduct\w*|kidnap\w*|terror\w*|militants?|insurgen\w+)\b/i,
  /\b(crash|derail\w*|collapse[sd]?|explosion|blast|fire kills|outbreak|epidemic|cholera)\b/i,
  /\b(rape|assault|abuse|trafficking|funerals?|mourning|victims?|survivors?)\b/i,
];

export function isSensitive(headline) {
  return PEOPLE_IN_HARM.some(re => re.test(String(headline)));
}

/* Work from the most specific subject in the headline down to its category,
   and prefer a result whose own title and tags echo the story. The point is a
   picture OF the story, not a picture of its genre. */
export async function findImage(headline, { fetchImpl = fetch, timeoutMs = 20000, exclude,
                                            minRelevance = 0.12, maxQueries = 2, topic } = {}) {
  if (prefersChart(headline))
    return { image: null, query: '(chart)', error: 'a chart illustrates this better than a photo' };
  if (isSensitive(headline))
    return { image: null, query: '(none)',
             error: 'a library photograph would misrepresent a story about people in harm' };

  // Each query is an API call, and the search is rate limited. Two per story —
  // the named subject and the category — is the useful part of the list; going
  // deeper mostly spends quota to arrive at the same fallback.
  const queries = queriesFor(headline, topic).slice(0, maxQueries);
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

    const toImage = (r, score) => ({
      url: r.url, credit: creditFor(r), license: r.license,
      source: r.source, pageUrl: r.foreign_landing_url, title: r.title,
      relevance: Math.round((score || 0) * 100) / 100,
      // A smaller rendition to fall back on. Originals can be enormous, and
      // the canvas is 1080 wide — a 13 MB master buys nothing.
      smallerUrl: r.thumbnail || null,
    });
    const image = toImage(chosen.r, chosen.score);
    // Alternatives for the caller to fall back on when a link is dead.
    image.alternatives = scored.slice(1, 4).map(x => toImage(x.r, x.score));

    // A query that actually matched wins outright. Anything weaker is held and
    // judged at the end — including on the last query, which used to be
    // returned regardless of whether it matched at all.
    if (chosen.score >= minRelevance) return { image, query: q, error: null };
    if (!fallback || (fallback.image.relevance || 0) < (image.relevance || 0))
      fallback = { image, query: q, error: null };
  }

  // An image with no word in common with the headline is not a picture of the
  // story — a search for "stock market trading screen" returned a red car for
  // a Wall Street headline. The generated chart is better than something
  // unrelated sitting under a news headline as if it illustrated it.
  if (fallback && !fallback.image.relevance)
    return { image: null, query: fallback.query,
             error: 'no image matched the story closely enough' };

  if (fallback) return fallback;
  return { image: null, query: queries[0],
           error: lastError || (exclude && exclude.size ? 'no unused image left' : 'nothing suitably licensed') };
}

/* Fetch the file itself. Refuses anything that is not actually an image, and
   anything implausibly large, since this runs unattended. */
export async function downloadImage(url, destPath, { fetchImpl = fetch, maxBytes = 30_000_000 } = {}) {
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
