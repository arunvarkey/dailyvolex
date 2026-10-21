/* Moving pictures of the actual story.
 *
 * The reel's footage, best first: the video the outlet put on the article,
 * then whatever link the owner hands over, then the photograph with a slow
 * push on it. The last of those is not footage and is not pretended to be —
 * it is a still that moves, which is what a bulletin does when there is no
 * tape.
 *
 * The same metadata trick as the photographs: og:video is declared so that
 * sharing a link shows a player, and reading it needs no key and no scraping
 * of the page body.
 */

const META = [
  /<meta[^>]+property=["']og:video:secure_url["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+property=["']og:video:url["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(?::(?:url|secure_url))?["']/i,
  /<meta[^>]+name=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/i,
];

/* A direct file ffmpeg can read, or a page a downloader has to resolve. */
export function kindOf(url) {
  const u = String(url || '');
  if (/\.(mp4|m4v|mov|webm)(\?|$)/i.test(u)) return 'file';
  if (/\.(m3u8|mpd)(\?|$)/i.test(u)) return 'stream';
  if (/^https?:/i.test(u)) return 'page';
  return null;
}

/* Players that are not the story: an advert slot, a live channel, a generic
   "watch our coverage" loop. */
const NOT_THE_STORY = /(advert|preroll|promo|sponsor|livestream|live-?tv|channel-?live|bumper|ident)/i;

export function videoUrlFrom(html, pageUrl) {
  const text = String(html || '');
  for (const re of META) {
    const m = text.match(re);
    if (!m) continue;
    const raw = m[1].trim().replace(/&amp;/g, '&');
    if (!raw) continue;
    let abs;
    try { abs = new URL(raw, pageUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    if (NOT_THE_STORY.test(abs)) continue;
    if (!kindOf(abs)) continue;
    return abs;
  }
  return null;
}

/* Never throws, for the same reason as the photographs: a story with no
   footage is a story with a photograph, and a run that dies because one
   newspaper was slow is a run with no post. */
export async function videoFromArticle(link, {
  source = '', fetchImpl = fetch, timeoutMs = 8000,
} = {}) {
  if (!link || !/^https?:/i.test(link))
    return { video: null, error: 'the story carries no link to read' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(link, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'DailyVolex/1.0 (+https://github.com/arunvarkey/dailyvolex)',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return { video: null, error: `HTTP ${res.status}` };

    const html = (await res.text()).slice(0, 200_000);
    const url = videoUrlFrom(html, res.url || link);
    if (!url) return { video: null, error: 'the article declares no video' };

    const named = String(source || '').split('·')[0].trim();
    return {
      video: {
        url,
        kind: kindOf(url),
        credit: named ? `Video: ${named}` : null,
        source: named || null,
        pageUrl: link,
        licence: 'publisher',
      },
      error: null,
    };
  } catch (err) {
    return { video: null,
             error: err?.name === 'AbortError' ? 'timed out' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
