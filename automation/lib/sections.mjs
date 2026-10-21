/* Sorting the day into sections.
 *
 * The feeds carry a `topic`, which is really just "which feed did this come
 * from". A section is the editorial shape a reader expects: Top stories first,
 * then India, World, Business, Technology — the taxonomy every news front has
 * used since long before Google News, and the one people already know how to
 * scan.
 *
 * Topics map many-to-one onto sections. Four of ours are all markets of one
 * kind or another, and to a reader they are one section, Business; splitting
 * them into "India markets" and "crypto" is an editorial distinction that only
 * means something to somebody already inside the subject.
 */

import { documentFrequency, sharesSubject } from './select.mjs';

/* Ordered by prominence, the way a front page is: Top first, then home news,
   then the world, then the rest. The order here is the order the posts are
   offered in. */
export const SECTIONS = [
  { id: 'top',      label: 'TOP STORIES', topics: null },   // drawn from everything
  { id: 'india',    label: 'INDIA',       topics: ['india'] },
  { id: 'world',    label: 'WORLD',       topics: ['world'] },
  // Crypto is a vertical inside Business, not a section. It was never a beat
  // this channel covers; it only looked like one because five of nineteen
  // feeds were crypto feeds.
  { id: 'business', label: 'BUSINESS',    topics: ['business', 'markets-india', 'markets-world', 'crypto'] },
  { id: 'tech',     label: 'TECHNOLOGY',  topics: ['tech'] },
  { id: 'science',  label: 'SCIENCE',     topics: ['science'] },
  { id: 'health',   label: 'HEALTH',      topics: ['health'] },
];

const BY_TOPIC = new Map();
for (const s of SECTIONS) for (const t of s.topics || []) BY_TOPIC.set(t, s.id);

/* A feed's topic is where a story arrived from, not what it is about.
 *
 * "Kenyan cult leader convicted of killing 190 children" came through an
 * Indian feed and was filed under INDIA. An Indian outlet reporting a Kenyan
 * conviction is world news; the only thing Indian about it is which website
 * we read it on.
 *
 * Only the india/world boundary is corrected, because that is where the
 * mistake is both common and obvious. Deciding that a business story is
 * "really" technology is an editorial call this has no business making. */
const FOREIGN = /\b(kenya|kenyan|nigeria|china|chinese|japan|japanese|korea|korean|russia|russian|ukraine|ukrainian|israel|israeli|gaza|palestin\w+|iran|iranian|iraq|syria|afghan\w*|pakistan\w*|bangladesh\w*|sri lanka\w*|nepal\w*|myanmar|france|french|germany|german|britain|british|uk|england|spain|spanish|italy|italian|canada|canadian|australia\w*|brazil\w*|mexico|egypt|turkey|turkish|saudi|qatar|uae|indonesia\w*|vietnam\w*|thailand|philippines|malaysia|singapore|taiwan|hong kong|europe|european union|eu|nato|united nations|un security council|washington|white house|kremlin|beijing|moscow|london|paris|berlin|tokyo|geneva|brussels)\b/i;
const HOME = /\b(india|indian|delhi|mumbai|bengaluru|bangalore|chennai|kolkata|hyderabad|kerala|punjab|gujarat|maharashtra|tamil nadu|karnataka|bihar|assam|modi|lok sabha|rajya sabha|supreme court of india|rbi|sebi|nse|bse|sensex|nifty)\b/i;

export function sectionOf(topic, headline) {
  const base = BY_TOPIC.get(topic) || 'top';
  if (!headline) return base;

  const h = String(headline);
  // A story filed under India that names a foreign place and nothing at home.
  if (base === 'india' && FOREIGN.test(h) && !HOME.test(h)) return 'world';
  // And the reverse: a world feed carrying an India story.
  if (base === 'world' && HOME.test(h) && !FOREIGN.test(h)) return 'india';
  return base;
}

export function sectionLabel(id) {
  return (SECTIONS.find(s => s.id === id) || {}).label || 'NEWS';
}

/* Split already-ranked clusters into sections.
 *
 * Top stories are chosen first and then held back from their own sections, so
 * no story appears in two posts. A reader scrolling the account should not
 * meet the same headline twice in one morning, and a section post made of
 * stories they have just seen in Top is not worth the tap.
 *
 * `eligible` is supplied by the caller rather than reimplemented here: it is
 * what enforces corroboration and the no-repeats rule, and having two places
 * decide what may be published is how one of them ends up more permissive.
 */
export function sortIntoSections(ranked, {
  top = [],                       // clusters already taken for Top stories
  perSection = 3,
  // Business is crypto, India markets and world markets together, and on a
  // busy crypto day it came out as three Bitcoin stories — one subject told
  // three times, which is not a section, it is a feed.
  maxPerTopic = 2,
  eligible = () => true,
  allowRepeatsInSections = false,
} = {}) {
  const taken = new Set(allowRepeatsInSections ? [] : top);
  const titlesInTop = allowRepeatsInSections ? [] : top.map(c => c.lead.title);

  const out = [{ id: 'top', label: 'TOP STORIES', clusters: top }];

  /* One story per subject, per section.
   *
   * INDIA went out with three cards about the Jio IPO: the share sale, the
   * price band, and the subscription figure. Clustering cannot catch that —
   * their wording overlaps less than an unrelated Jio story does, so any
   * threshold that merged them would merge things that are not the same
   * story. Counting which words are rare across the day's headlines can:
   * "jio" in three of them is a subject, and a section does not need the
   * same subject three times. */
  const df = documentFrequency(ranked.map(c => c.lead.title));

  for (const section of SECTIONS) {
    if (section.id === 'top') continue;
    const chosen = [];
    const perTopic = new Map();

    const consider = (capped) => {
      for (const c of ranked) {
        if (chosen.length >= perSection) break;
        if (taken.has(c)) continue;
        if (sectionOf(c.lead.topic, c.lead.title) !== section.id) continue;
        if (capped && (perTopic.get(c.lead.topic) || 0) >= maxPerTopic) continue;
        // Unlike the topic cap, this one is NOT dropped when filling the
        // remaining slots. A shorter section is better than the same story
        // told three times — that is what the second pass is for, and it is
        // how all three Jio cards got in.
        if (chosen.some(x => sharesSubject(c.lead.title, x.lead.title, df))) continue;
        // A minor story never publishes — not in Top, and not riding along in
        // a section either. The old rule only required one story above minor
        // per section, so a product launch still went out beside real news.
        if (c.tier === 'minor') continue;
        if (!eligible(c, chosen, titlesInTop)) continue;
        chosen.push(c);
        taken.add(c);
        perTopic.set(c.lead.topic, (perTopic.get(c.lead.topic) || 0) + 1);
      }
    };

    consider(true);
    // Then fill any remaining slot without the cap, rather than running a
    // shorter section on a day when one subject genuinely is the news.
    consider(false);

    out.push({ id: section.id, label: section.label, clusters: chosen });
  }

  // A section with nothing in it is not a post. Nor is one where nothing rises
  // above minor: BUSINESS came out as three Bitcoin items, every one of them
  // a price or a purchase, and a post made entirely of those says the channel
  // thinks they are the day's business news. Top is kept even when thin,
  // because an empty Top means the whole run found nothing, and that should
  // be visible rather than quietly dropped.
  // Nothing minor gets this far now, so a section is worth posting when it
  // has anything in it at all.
  const worthPosting = s => s.clusters.length > 0;

  return out.filter(s => s.id === 'top' || worthPosting(s));
}
