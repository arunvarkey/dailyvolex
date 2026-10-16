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

export function parseFeed(xml, feed) {
  if (!xml || typeof xml !== 'string') return [];
  const out = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];

  for (const block of blocks.slice(0, MAX_ITEMS_PER_FEED)) {
    const title = tag(block, 'title');
    if (!title) continue;

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
      source: feed.name,
      feedId: feed.id,
      topic: feed.topic,
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
