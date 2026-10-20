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

export const SECTIONS = [
  { id: 'top',      label: 'TOP STORIES', topics: null },   // drawn from everything
  { id: 'india',    label: 'INDIA',       topics: ['india'] },
  { id: 'world',    label: 'WORLD',       topics: ['world'] },
  { id: 'business', label: 'BUSINESS',    topics: ['business', 'markets-india', 'markets-world', 'crypto'] },
  { id: 'tech',     label: 'TECHNOLOGY',  topics: ['tech'] },
];

const BY_TOPIC = new Map();
for (const s of SECTIONS) for (const t of s.topics || []) BY_TOPIC.set(t, s.id);

export function sectionOf(topic) {
  return BY_TOPIC.get(topic) || 'top';
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

  for (const section of SECTIONS) {
    if (section.id === 'top') continue;
    const chosen = [];
    const perTopic = new Map();

    const consider = (capped) => {
      for (const c of ranked) {
        if (chosen.length >= perSection) break;
        if (taken.has(c)) continue;
        if (sectionOf(c.lead.topic) !== section.id) continue;
        if (capped && (perTopic.get(c.lead.topic) || 0) >= maxPerTopic) continue;
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

  // A section with nothing in it is not a post. Top is kept even when thin,
  // because an empty Top means the whole run found nothing and that should be
  // visible rather than quietly dropped.
  return out.filter(s => s.id === 'top' || s.clusters.length);
}
