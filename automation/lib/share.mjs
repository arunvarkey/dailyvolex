/* What makes a reader pass a story on.
 *
 * The owner asked for stories people tend to share. The obvious way to do
 * that is the wrong one: rank by outrage, celebrity and speculation, and the
 * account stops being a news channel within a week. Reach bought that way is
 * not reach this channel can keep, because the only thing it has is being
 * believed.
 *
 * So this is deliberately WEAK and deliberately BOUNDED. It is a tie-breaker
 * INSIDE a tier, never a promoter across one: a minor story cannot out-score
 * a lead however shareable it is. TIER_POINTS are 10/6/3/0 and the most this
 * can add is 2.5, which is less than the gap between any two tiers. The front
 * page is still decided by what matters; this only decides which of two
 * stories that matter equally goes first.
 *
 * What it rewards is what actually gets a news post forwarded, and each of
 * these is defensible as journalism rather than as engagement bait:
 *
 *   a figure        one repeatable fact — "$25bn", "40 dead". The thing
 *                   somebody retells in a sentence.
 *   scale           how many people it happened to.
 *   a first         a record, a largest, a first time. Genuinely novel.
 *   accountability  somebody convicted, fined, resigning, ordered to pay.
 *                   People share consequences.
 *   relief          a rescue, a release, a recovery. Good news travels and
 *                   this channel refuses almost all of it by default.
 *   proximity       it happened here, to this audience.
 *
 * And what it refuses to reward, explicitly, because every one of them is
 * how a news account turns into a content account:
 *
 *   outrage, celebrity, speculation about what might happen, anything
 *   phrased as a question, anything about what someone said rather than
 *   what someone did.
 *
 * Pure. A headline in, points and the reasons out — the reasons so the
 * ranking can be argued with rather than just trusted.
 */

/* The most this may add. Less than the smallest gap between two tiers
   (notable 3 → significant 6), so it can reorder within a tier and never
   across one. */
export const MAX_SHARE_POINTS = 2.5;

const SIGNALS = [
  { why: 'carries a figure people can repeat', points: 0.8,
    // A number with a unit or a currency: "$25bn", "40 killed", "1,000
    // arrested". A bare year is not a fact about the story.
    test: h => /[$€£₹]\s?\d|\b\d[\d,.]*\s?(bn|billion|m\b|million|crore|lakh|per cent|%|people|killed|dead|injured|arrested|jobs?|years?)\b/i.test(h)
            && !/\b(19|20)\d\d\b(?!\s?(bn|billion|crore|lakh|%))/.test(h.replace(/[$€£₹]\s?\d[\d,.]*/g, '')) },

  { why: 'says how many people it happened to', points: 0.6,
    test: h => /\b(thousands|millions|hundreds of|lakh|crore|nationwide|across the country|worldwide)\b/i.test(h) },

  { why: 'a first, a record or a largest', points: 0.6,
    test: h => /\b(first (ever|time|woman|man|country|state)|record|biggest|largest|highest|worst|deadliest|fastest|youngest|oldest)\b/i.test(h) },

  { why: 'somebody is held to account', points: 0.5,
    test: h => /\b(convicted|sentenced|jailed|fined|resigns?|resigned|steps down|ordered to pay|struck down|overturn\w+|impeach\w+|arrested|charged|guilty)\b/i.test(h) },

  { why: 'a rescue, a release or a recovery', points: 0.5,
    test: h => /\b(rescued?|freed|released|survivors?|reunited|cured|recovers?|saved|evacuat\w+|cleared of|acquitted)\b/i.test(h) },

  { why: 'it happened where the readers are', points: 0.4,
    test: (h, story) => /\b(india|indian|delhi|mumbai|bengaluru|chennai|kolkata|kerala|punjab|gujarat|maharashtra|tamil nadu)\b/i.test(h)
                     || story?.topic === 'india' || /india/i.test(String(story?.countries || '')) },
];

/* The things this will not pay for, whatever else the headline does.
 *
 * Checked first and separately from the editorial filters in select.mjs,
 * which refuse these outright. This exists for the ones that get through:
 * a real story told in the register of a tabloid still should not be
 * promoted for being told that way. */
const NOT_PAID_FOR = [
  /\?\s*$/,                                              // asks rather than reports
  /\b(slams?|blasts?|hits? out|lashes? out|destroys?|shocking|stunning|unbelievable|you won'?t believe)\b/i,
  /\b(could|might|may|set to|expected to|likely to|poised to|on track to)\b/i,
  /\b(says|said|claims?|tells?|slams?)\b[^.]*$/i,        // somebody talking
];

/* How likely a story is to be passed on, and why.
 *
 * Returns { points, reasons }. Points are capped at MAX_SHARE_POINTS so no
 * combination of signals can carry a story out of its tier. */
export function shareScore(headline, story = {}) {
  const h = String(headline || '');
  if (!h.trim()) return { points: 0, reasons: [] };

  if (NOT_PAID_FOR.some(re => re.test(h)))
    return { points: 0, reasons: [], refused: 'written as comment, speculation or a question' };

  const reasons = [];
  let points = 0;
  for (const s of SIGNALS) {
    if (!s.test(h, story)) continue;
    reasons.push(s.why);
    points += s.points;
  }
  return { points: Math.min(MAX_SHARE_POINTS, Math.round(points * 100) / 100), reasons };
}

export function sharePoints(headline, story) {
  return shareScore(headline, story).points;
}
