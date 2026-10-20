/* Wikimedia Commons as the image source.
 *
 * Openverse throttles an unauthenticated client hard: a probe from the runner
 * got one answer out of eight and the other seven hung for twenty-five
 * seconds each. That is one photograph per run, which is what the account was
 * getting. Commons answered four out of four with a median of a second, needs
 * no key, and is far larger.
 *
 * Results are mapped onto the same shape Openverse returns, so everything
 * downstream — the licence check, the relevance scoring, the credit line —
 * works unchanged and keeps its tests.
 *
 * Licensing is the part that must not be sloppy. Commons carries plenty of
 * share-alike and GFDL material, and the rule here is the same as it has
 * always been: CC0, public domain and CC BY are usable; anything with SA, NC,
 * ND or GFDL is refused, because a share-alike image would arguably oblige
 * the finished graphic to be licensed the same way.
 */

const API = 'https://commons.wikimedia.org/w/api.php';

/* Commons gives a machine-ish code in extmetadata.License and a human one in
   LicenseShortName. Read both; believe neither without checking. */
export function licenceFrom(meta = {}) {
  const raw = String(meta.License?.value || '').toLowerCase().trim();
  const short = String(meta.LicenseShortName?.value || '').toLowerCase().trim();
  const both = `${raw} ${short}`;

  // Refuse first. A single "sa" anywhere is enough to disqualify, and
  // guessing generously here is how an infringement happens.
  if (/\b(sa|share[- ]alike)\b|-sa|\bnc\b|-nc|\bnd\b|-nd|gfdl|fal\b/.test(both)) return null;
  if (/cc0|cc-zero/.test(both)) return { license: 'cc0', version: null };
  if (/public ?domain|^pd|\bpd\b|pdm/.test(both)) return { license: 'pdm', version: null };
  const by = both.match(/cc[- ]by[- ]?(\d\.\d)?/);
  if (by) return { license: 'by', version: by[1] || null };
  return null;                       // unknown terms are not permission
}

/* extmetadata values are HTML fragments. */
function text(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/* Commons titles are "File:Some descriptive name.jpg" — the descriptive part
   is genuinely useful for relevance scoring, so keep it and drop the rest. */
function cleanTitle(t) {
  return String(t || '').replace(/^File:/i, '').replace(/\.(jpe?g|png|gif|webp|tiff?)$/i, '')
    .replace(/[_-]+/g, ' ').trim();
}

/* Map a Commons page onto the shape the rest of the pipeline expects from
   Openverse, so no caller has to know where a picture came from. */
export function toResult(page) {
  const info = page?.imageinfo?.[0];
  if (!info?.url) return null;
  const meta = info.extmetadata || {};
  const lic = licenceFrom(meta);
  if (!lic) return null;             // not usable — drop it here, not later

  const categories = text(meta.Categories?.value || '')
    .split('|').map(s => s.trim()).filter(Boolean).slice(0, 12);

  return {
    url: info.url,
    width: info.width,
    height: info.height,
    creator: text(meta.Artist?.value) || text(meta.Credit?.value) || 'Wikimedia Commons',
    license: lic.license,
    license_version: lic.version,
    foreign_landing_url: info.descriptionurl || null,
    title: cleanTitle(page.title),
    // Relevance scores against title and tags; Commons categories are the
    // closest thing it has to tags and they are often very descriptive.
    tags: categories.map(name => ({ name })),
    // A resized rendition, so a 40MB master is never downloaded for a canvas
    // that is 1080 wide.
    thumbnail: info.thumburl || null,
    provider: 'wikimedia',
  };
}

export async function searchCommons(q, { fetchImpl = fetch, timeoutMs = 15000,
                                         limit = 10 } = {}) {
  const url = `${API}?action=query&format=json&origin=*`
    + '&generator=search&gsrnamespace=6'          // namespace 6 is File:
    + `&gsrlimit=${limit}`
    // filetype:bitmap keeps out SVGs, PDFs and video, which cannot be used
    // as a photographic backdrop.
    + `&gsrsearch=${encodeURIComponent('filetype:bitmap ' + q)}`
    + '&prop=imageinfo&iiprop=url|extmetadata|size&iiurlwidth=1600';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: ctrl.signal,
      // Wikimedia asks clients to identify themselves and is strict about it.
      headers: { 'user-agent': 'DailyVolex/1.0 (https://github.com/arunvarkey/dailyvolex)' },
    });
    if (res.status === 429) return { results: [], error: 'rate limited by Commons (429)' };
    if (!res.ok) return { results: [], error: `HTTP ${res.status}` };
    const body = await res.json();
    const pages = Object.values(body?.query?.pages || {});
    return { results: pages.map(toResult).filter(Boolean), error: null };
  } catch (err) {
    return { results: [],
             error: err?.name === 'AbortError' ? 'timed out'
                                               : String(err?.message || err) };
  } finally { clearTimeout(timer); }
}
