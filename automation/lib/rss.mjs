/* A small RSS/Atom reader.
 *
 * Deliberately dependency-free: this runs unattended on a schedule, and every
 * package added here is one more thing that can break a morning's posts or go
 * bad in a way nobody notices. Feeds are simple enough not to need a parser.
 *
 * Feed content is untrusted — it is whatever a publisher put in their XML — so
 * everything is treated as text, never as markup, and lengths are capped.
 */

const MAX_ITEMS_PER_FEED = 40;
const MAX_FIELD = 400;

/* Decode the handful of entities that actually appear in feed titles. */
function decodeEntities(str) {
  return str
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');          // last, so &amp;lt; does not become <
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

/* Strip tags, collapse whitespace, cap length.
   Tags are stripped on both sides of decoding: a title carrying &lt;b&gt;
   decodes INTO markup, and stripping only beforehand leaves it in the text. */
function clean(str) {
  if (!str) return '';
  const once = String(str).replace(/<[^>]*>/g, ' ');
  return decodeEntities(once)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FIELD);
}

function tag(block, name) {
  // CDATA first: titles routinely wrap markup in it.
  const cdata = new RegExp(`<${name}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, 'i').exec(block);
  if (cdata) return clean(cdata[1]);
  const plain = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return plain ? clean(plain[1]) : '';
}

/* Atom puts the link in an attribute rather than in the element body. */
function atomLink(block) {
  const m = /<link[^>]*href=["']([^"']+)["']/i.exec(block);
  return m ? clean(m[1]) : '';
}

/* Google News titles always end "— Real Publisher". Without pulling that out,
   an aggregator counts as an outlet in its own right, so a single CoinDesk
   story syndicated through Google News scores as TWO independent sources. That
   quietly inflates the corroboration count the whole selection rests on. */
const PUBLISHER_SUFFIX = /\s[-\u2013\u2014]\s([^-\u2013\u2014]{2,40})\s*$/;

function splitPublisher(title) {
  const m = PUBLISHER_SUFFIX.exec(title);
  if (!m) return { title, publisher: null };
  const publisher = m[1].trim();
  // A trailing clause is not a publisher: real ones are short and have no
  // sentence punctuation.
  if (/[.,;:!?]$/.test(publisher) || publisher.split(/\s+/).length > 5)
    return { title, publisher: null };
  return { title: title.slice(0, m.index).trim(), publisher };
}

/* The picture the feed itself carries.
 *
 * Most news feeds name the story's photograph inline — <media:content>,
 * <media:thumbnail> or an <enclosure>. Reading it here costs nothing: the
 * feed has already been fetched, so there is no second request, and nothing
 * to be blocked. NDTV answers 403 to a request for its article page and
 * hands over the same photograph in its RSS without being asked.
 */
export function imageIn(block) {
  const patterns = [
    /<media:content[^>]+url=["']([^"']+)["']/i,
    /<media:thumbnail[^>]+url=["']([^"']+)["']/i,
    /<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image\//i,
    /<enclosure[^>]+type=["']image\/[^"']*["'][^>]*url=["']([^"']+)["']/i,
    // Some feeds put the picture in the description's HTML and nowhere else.
    /<img[^>]+src=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i,
  ];
  for (const re of patterns) {
    const m = String(block || '').match(re);
    if (!m) continue;
    const url = m[1].trim().replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(url)) return url;
  }
  return null;
}

export function parseFeed(xml, feed) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];

  for (const block of blocks.slice(0, MAX_ITEMS_PER_FEED)) {
    let title = tag(block, 'title');
    if (!title) continue;

    // For an aggregator, the publisher in the title is the real source.
    let source = feed.name;
    if (feed.aggregator) {
      const split = splitPublisher(title);
      if (split.publisher) { title = split.title; source = split.publisher; }
    }

    const link = tag(block, 'link') || atomLink(block);
    const dateStr = tag(block, 'pubDate') || tag(block, 'published')
                 || tag(block, 'updated') || tag(block, 'dc:date');
    const published = Date.parse(dateStr);

    out.push({
      title,
      link,
      summary: tag(block, 'description') || tag(block, 'summary'),
      // An unparseable date must not read as "right now" — that would let a
      // stale item win the freshness ranking. Treat it as old instead.
      published: Number.isFinite(published) ? published : 0,
      source,
      // The photograph the feed named, if it named one. Free: the feed is
      // already in hand, so there is no second request to be refused.
      feedImage: imageIn(block),
      feedId: feed.id,
      topic: feed.topic,
      requireTopical: !!feed.requireTopical,
      weight: typeof feed.weight === 'number' ? feed.weight : 1,
    });
  }
  return out;
}

export async function fetchFeed(feed, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(feed.url, {
      signal: ctrl.signal,
      headers: {
        // Some publishers serve an error page to an unidentified client.
        'user-agent': 'DailyVolex/1.0 (+https://github.com/arunvarkey/dailyvolex)',
        'accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) return { feed, items: [], error: `HTTP ${res.status}` };
    return { feed, items: parseFeed(await res.text(), feed), error: null };
  } catch (err) {
    // One dead feed must never take the run down with it.
    return { feed, items: [], error: err && err.name === 'AbortError' ? 'timed out' : String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
