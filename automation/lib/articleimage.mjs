/* The photograph the outlet put on the story.
 *
 * Every picture on this channel came from Wikimedia Commons: openly licensed,
 * safe, and frequently nothing to do with the story. A card about a court
 * ruling in Chandigarh got a stock photograph of a courthouse somewhere else,
 * or no photograph at all, and about four cards in ten went out over a
 * gradient.
 *
 * The owner's decision is that the story matters more than the licence. So
 * the first place to look is the article itself: whatever the outlet chose to
 * illustrate it with is, by definition, a picture OF the story rather than a
 * picture of its genre. It is also the outlet's copyright, and that is the
 * trade being made deliberately — a news agency can issue a takedown, and
 * Instagram can act on one.
 *
 * Two things follow from that and are built in rather than left to goodwill:
 * the outlet is always credited by name on the card, and the approval issue
 * says which pictures came from an article so the owner can see what they are
 * approving before it goes out.
 *
 * No API key. The image is named in the page's own metadata, which is there
 * precisely so that sharing a link shows a picture.
 */

/* Where a page declares its own illustration, best first. og:image is what
   every social platform reads, so it is the one outlets actually maintain. */
const META = [
  /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i,
  /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
  /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
];

/* Images that are furniture rather than journalism. A masthead, a share
   button or a tracking pixel is declared as og:image often enough to matter,
   and a card illustrated with a newspaper's own logo looks like a mistake
   because it is one. */
const FURNITURE = /(logo|favicon|sprite|placeholder|default[-_]?(image|thumb)|share[-_]?(icon|image)|1x1|pixel|blank|avatar|gravatar|_amp|facebook-?default)/i;

export function isFurniture(url) {
  const path = String(url || '').split('?')[0];
  return FURNITURE.test(path);
}

/* Pull the declared image out of a page, resolved to an absolute URL. */
export function imageUrlFrom(html, pageUrl) {
  const text = String(html || '');
  for (const re of META) {
    const m = text.match(re);
    if (!m) continue;
    const raw = m[1].trim().replace(/&amp;/g, '&');
    if (!raw) continue;
    let abs;
    try { abs = new URL(raw, pageUrl).toString(); } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    if (isFurniture(abs)) continue;
    return abs;
  }
  return null;
}

/* The outlet's name, for the credit line. Falls back to the host, because a
   picture whose source cannot be named does not go on a card. */
export function creditFor(source, pageUrl) {
  const named = String(source || '').split('·')[0].trim();
  if (named) return `Photo: ${named}`;
  try { return `Photo: ${new URL(pageUrl).hostname.replace(/^www\./, '')}`; }
  catch { return null; }
}

/* Fetch the article and read the picture it declares.
 *
 * Never throws: a story with no picture is a story over a backdrop, and a
 * run that dies because one newspaper was slow is a run with no post. */
export async function imageFromArticle(link, {
  source = '', fetchImpl = fetch, timeoutMs = 8000,
} = {}) {
  if (!link || !/^https?:/i.test(link))
    return { image: null, error: 'the story carries no link to read' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(link, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        // Identified, not disguised. A site that would rather this did not
        // happen can say so, and several do.
        'user-agent': 'DailyVolex/1.0 (+https://github.com/arunvarkey/dailyvolex)',
        accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return { image: null, error: `HTTP ${res.status}` };

    // Only the head is needed — og:image lives in it — and some front pages
    // are megabytes of markup.
    const html = (await res.text()).slice(0, 200_000);
    const url = imageUrlFrom(html, res.url || link);
    if (!url) return { image: null, error: 'the article declares no picture' };

    const credit = creditFor(source, link);
    if (!credit) return { image: null, error: 'no outlet to credit the picture to' };

    return {
      image: {
        url,
        credit,
        // Said plainly in the data: this is the outlet's own photograph, used
        // without a licence, and the approval issue shows it as such.
        licence: 'publisher',
        pageUrl: link,
        source: String(source || '').split('·')[0].trim() || null,
      },
      error: null,
    };
  } catch (err) {
    return { image: null,
             error: err?.name === 'AbortError' ? 'timed out' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}
