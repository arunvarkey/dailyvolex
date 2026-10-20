/* When a headline is really about a number, show the number.
 *
 * Every card in every post was the same shape, which is most of why a
 * thirteen-slide post read flat. The app has had a stat layout since the
 * beginning and the automation never used it: one enormous figure is the
 * thing that stops a thumb.
 *
 * The rule that cannot bend: everything on the card is lifted verbatim from
 * the headline. The figure is a substring, the label is the words that follow
 * it, and the headline itself sits underneath in full. Rewriting a headline
 * to fit a layout would be inventing, and this channel does not write — it
 * only ever removes.
 */

/* Numbers that are not the point of the story. */
const NOT_A_STAT = [
  /^(19|20)\d{2}$/,                  // a year
  /^\d{1,2}(st|nd|rd|th)$/i,         // an ordinal: 3rd T20I
  /^\d{1,2}$/,                       // bare one- and two-digit numbers need a unit
];

/* Units that make a bare number meaningful. */
const UNIT = /^(crore|lakh|million|billion|trillion|percent|per cent|points?|basis points?|bps|medals?|golds?|people|killed|dead|seats?|votes?|jobs?|years?|days?|months?|tonnes?|km|miles?)\b/i;

/* A casualty count is the story even when nothing follows the figure:
   "Earthquake kills at least 40 in northern Afghanistan" was falling through
   to a plain card because "in northern Afghanistan" is not a unit. */
const TOLL_BEFORE = /\b(kills?|killed|dead|died|deaths?|injured|wounded|hurt|arrested|detained|rescued|missing|evacuated|displaced|convicted)\s+(at least\s+|about\s+|nearly\s+|more than\s+|over\s+|some\s+)?$/i;

/* Words that cannot begin a label — the phrase after the number is a
   preposition and the number's meaning lives before it instead. */
const WEAK_START = /^(in|at|on|of|for|to|from|as|by|with|after|before|and|or|but|that|which|who|a|an|the)\b/i;

/* Find the figure a headline is about, with the words that give it meaning.
   Returns null when there is no such figure, which is most of the time. */
export function statFor(headline) {
  const text = String(headline || '').trim();
  if (!text) return null;

  // Currency or percentage first: those are always the point when present.
  // The figure is taken exactly as written, symbol, commas and all.
  const money = text.match(/([₹$€£¥]\s?[\d,.]+\s?(crore|lakh|million|billion|trillion|bn|mn|m|k)?)/i);
  const pct = text.match(/(\d[\d,.]*\s?(%|per cent|percent))/i);
  const plain = text.match(/\b(\d[\d,]*(?:\.\d+)?)\b/);

  const hit = money || pct || plain;
  if (!hit) return null;

  const stat = hit[1].replace(/\s+/g, ' ').trim();
  const bare = stat.replace(/[^\d]/g, '');
  if (!bare) return null;

  // What sits either side of the figure in the headline, verbatim.
  const after = text.slice(hit.index + hit[0].length).trim();
  const before = text.slice(0, hit.index);
  const isToll = TOLL_BEFORE.test(before);

  if (!money && !pct) {
    if (NOT_A_STAT.some(re => re.test(stat))) {
      // A small bare number is only a stat when a unit follows it, or when
      // it is a count of people something happened to.
      if (!UNIT.test(after) && !isToll) return null;
    }
    if (bare.length < 2 && !UNIT.test(after) && !isToll) return null;
  }

  // The label is the words after the figure, cut at the first punctuation so
  // it never runs into the next clause. Dropped entirely when it starts on a
  // preposition, because "40 in northern Afghanistan" reads as a fragment and
  // the headline below already says it.
  let label = after.split(/[,;:–—]|\s+-\s+/)[0].trim();
  if (WEAK_START.test(label)) label = '';
  // Stop the label before it runs into the next clause: "876 points as banks
  // drag the" is a sentence cut in half, not a label.
  label = label.split(/\s+(?:as|after|while|when|amid|following|despite|since|because)\s+/i)[0];
  label = label.split(/\s+/).slice(0, 4).join(' ').replace(/[.!?]+$/, '');

  return { stat, label };
}

/* Whether this story should use the stat layout at all. A card is only worth
   building around a figure when the figure is what happened. */
export function prefersStat(story) {
  if (!story || story.kind === 'correction') return false;
  const s = statFor(story.display || story.headline);
  if (!s) return false;
  // A figure buried at the very end of a long headline is usually a detail,
  // not the story.
  const text = String(story.display || story.headline);
  return text.indexOf(s.stat) < text.length * 0.75;
}
