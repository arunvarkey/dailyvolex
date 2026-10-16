/* Deciding what is worth posting.
 *
 * The ranking rests on one idea: a story carried by several independent
 * outlets within a few hours is far more likely to be real and to matter than
 * a single outlet's piece. That is also the cheapest available defence against
 * putting something false out under the channel's name.
 */

const STOP = new Set(('a an the and or but of for to in on at by with from as is are was were be been '
  + 'has have had will would could should may might can says said after before over under new '
  + 'this that these those it its his her their our your up down out off than then now').split(' '));

/* Outlets write the same fact differently, and the differences are
   predictable. Without folding these together, "Fed cuts rates 25bps" and
   "Federal Reserve cuts rates by 25 basis points" look like two separate
   stories — which would wreck the corroboration count that everything here
   depends on. */
function normalise(title) {
  return String(title).toLowerCase()
    .replace(/(\d)([a-z])/g, '$1 $2')             // 25bps -> 25 bps
    .replace(/\bbasis points?\b/g, 'bps')
    .replace(/\bpercentage points?\b/g, 'pct')
    .replace(/\bper cent\b|\bpercent\b/g, 'pct')
    .replace(/\bfederal reserve\b/g, 'fed')
    .replace(/\breserve bank of india\b/g, 'rbi')
    .replace(/\bsecurities and exchange commission\b/g, 'sec')
    .replace(/\bexchange[- ]traded funds?\b/g, 'etf')
    .replace(/[^a-z0-9$%. ]/g, ' ');
}

/* Words that carry meaning, for comparing two headlines. */
export function keyWords(title) {
  return new Set(
    normalise(title)
      .split(/\s+/)
      // Numbers are kept whatever their length: "25" and "$90,000" are often
      // the most identifying part of a market headline.
      .filter(w => (w.length > 2 || /\d/.test(w)) && !STOP.has(w))
  );
}

export function similarity(a, b) {
  const A = keyWords(a), B = keyWords(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);      // overlap, not Jaccard:
}                                                // a short headline inside a
                                                 // long one still counts.

/* Group items that are plainly the same story. */
export function cluster(items, threshold = 0.5) {
  const clusters = [];
  for (const item of items) {
    let placed = false;
    for (const c of clusters) {
      if (similarity(item.title, c.items[0].title) >= threshold) {
        c.items.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ items: [item] });
  }
  return clusters;
}

/* How many genuinely different outlets carry a story. Two feeds owned by the
   same publisher, or the same story twice from Google News, are not
   corroboration, so count distinct source names. */
function distinctSources(cluster) {
  return new Set(cluster.items.map(i => i.source)).size;
}

function freshnessScore(ts, now) {
  if (!ts) return 0;                       // unknown date: no freshness credit
  const hours = (now - ts) / 3600000;
  if (hours < 0) return 0.5;               // future-dated: treat with suspicion
  if (hours <= 2)  return 1;
  if (hours <= 6)  return 0.8;
  if (hours <= 12) return 0.5;
  if (hours <= 24) return 0.25;
  return 0;
}

export function rankClusters(clusters, { now = Date.now() } = {}) {
  return clusters.map(c => {
    const newest = Math.max(...c.items.map(i => i.published || 0));
    const sources = distinctSources(c);
    const weight = Math.max(...c.items.map(i => i.weight || 1));
    const lead = c.items.slice().sort((a, b) => (b.published || 0) - (a.published || 0))[0];

    // Corroboration dominates; freshness and outlet weight only break ties.
    const score = (sources * 2) + (freshnessScore(newest, now) * 1.5) + (weight - 1);

    return {
      ...c,
      lead,
      sources,
      sourceNames: [...new Set(c.items.map(i => i.source))],
      newest,
      score: Math.round(score * 1000) / 1000,
    };
  }).sort((a, b) => b.score - a.score);
}

/* Stories already posted, or already offered for approval, must not come back.
   Matching is by similarity rather than by URL: the same story reappears under
   a different link constantly. */
export function isRepeat(title, history, threshold = 0.6) {
  return history.some(h => similarity(title, h.title) >= threshold);
}

export function selectStories(items, { history = [], count = 3, now = Date.now(),
                                       minSources = 1, maxAgeHours = 24 } = {}) {
  const cutoff = now - maxAgeHours * 3600000;
  const fresh = items.filter(i => !i.published || i.published >= cutoff);

  const ranked = rankClusters(cluster(fresh), { now });
  const chosen = [];
  const takenTitles = [];

  for (const c of ranked) {
    if (chosen.length >= count) break;
    if (c.sources < minSources) continue;
    if (isRepeat(c.lead.title, history)) continue;
    // Do not pick two near-identical stories in one batch either.
    if (isRepeat(c.lead.title, takenTitles.map(t => ({ title: t })))) continue;
    chosen.push(c);
    takenTitles.push(c.lead.title);
  }
  return chosen;
}
