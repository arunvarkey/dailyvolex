/* Turning a news title into a headline that fits the Breaking layout.
 *
 * Rules only, no AI: this runs free and offline, and the result is reviewed
 * before anything is posted. The one firm rule is that it only ever REMOVES
 * from what the outlet wrote — it never adds a word, never sharpens a claim,
 * and never turns a hedge into a fact. A shortener that editorialises is how
 * an automated news account ends up asserting something nobody reported.
 */

const MAX = 90;        // comfortable for three lines in the Breaking layout

/* Outlet furniture that carries no information. */
const TRAILING_SOURCE = /\s*[|–—-]\s*(reuters|bloomberg|cnbc|coindesk|cointelegraph|decrypt|the block|economic times|moneycontrol|mint|livemint|business standard|ndtv profit|et now|the hindu|times of india|investing\.com|cryptoticker|yahoo finance|bbc news|al jazeera|ndtv)\s*$/i;

/* Some outlets append their own byline: "… today? By Investing.com". */
const TRAILING_BYLINE = /\s+[Bb]y\s+[A-Z][\w.&' -]{2,30}\s*$/;

const PREFIXES = [
  /^(breaking|exclusive|just in|update|live|watch|explained|analysis|opinion)\s*[:–—-]\s*/i,
];

/* Phrases that can go without changing what is being claimed. */
const FILLER = [
  /\b(according to (a )?(new )?(report|reports|sources|data)|sources say|report says|reports say)\b[,:]?\s*/gi,
  /\b(here'?s (what|why|how)|what to know|here is what)\b[,:]?\s*/gi,
  /\s*\((reuters|ap|pti|ani|bloomberg)\)\s*/gi,
];

export function tidy(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  t = t.replace(TRAILING_SOURCE, '');
  t = t.replace(TRAILING_BYLINE, '');
  for (const p of PREFIXES) t = t.replace(p, '');
  for (const f of FILLER) t = t.replace(f, ' ');
  return t.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
}

/* Words a headline must not end on. "Stock market holiday tomorrow on
   Dussehra: Are BSE" is not a shorter headline, it is half of one — and it
   went out on a card. */
const DANGLING = new Set(('a an the and or but of for to in on at by with from as is are was were '
  + 'be been has have had will would could should may might can could its his her their our your '
  + 'this that these those into onto over under after before between about than then').split(' '));

function endsWell(head) {
  const last = head.split(' ').pop().toLowerCase().replace(/[^a-z']/g, '');
  return !!last && !DANGLING.has(last);
}

/* Drop a trailing clause when that alone gets it under the cap, and only if
   what remains still reads as a complete statement of reasonable length. */
function trimClause(t, max) {
  if (t.length <= max) return t;

  // A colon, semicolon or full stop closes a thought; a comma is as likely to
  // be sitting in the middle of a list. Strong boundaries are tried first, so
  // the Dussehra headline loses its whole question rather than half of it.
  const strong = [], weak = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === ':' || c === ';' || c === '?' || c === '!' || (c === '.' && t[i+1] === ' ')) strong.push(i);
    else if (c === ',' || c === '—' || c === '–' || (c === '-' && t[i-1] === ' ')) weak.push(i);
  }

  for (const cuts of [strong, weak]) {
    for (let i = cuts.length - 1; i >= 0; i--) {
      const head = t.slice(0, cuts[i]).trim();
      if (head.length <= max && head.length >= max * 0.45
          && head.split(' ').length >= 4 && endsWell(head)) return head;
    }
  }
  return t;
}

/* Last resort: cut at a word boundary. Never mid-word, never mid-number, and
   never leaving the headline hanging on "to" or "and". */
function hardTrim(t, max) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  let out = (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–—-]+$/, '');
  while (out.includes(' ') && !endsWell(out)) {
    out = out.slice(0, out.lastIndexOf(' ')).replace(/[\s,;:.–—-]+$/, '');
  }
  return out;
}

export function makeHeadline(raw, { max = MAX } = {}) {
  const tidied = tidy(raw);
  if (!tidied) return { headline: '', truncated: false, usable: false };

  let out = tidied;

  if (out.length > max) {
    out = trimClause(out, max);
    if (out.length > max) out = hardTrim(out, max);
  }
  // Anything shorter than what the outlet wrote has been shortened, clause cut
  // or not. Reporting only hard trims meant a card that had lost a whole
  // question was listed for approval as untouched.
  const truncated = out !== tidied;

  return {
    headline: out.toUpperCase(),     // Breaking layout sets headlines in caps
    // As the outlet wrote it, for lists. Re-casing destroys proper nouns —
    // "Federal Reserve" became "Federal reserve", "SEC" became "Sec" — and
    // guessing at capitalisation is one more way to misrepresent a source.
    display: out,
    original: raw,
    truncated,
    // A headline cut so hard it lost its verb is not worth posting; flag it
    // for review rather than quietly publishing a fragment.
    usable: out.split(' ').length >= 4 && out.length >= 20,
  };
}

/* The small label above the headline. Derived from the topic, never invented
   from the story's content. */
/* The feed a story arrived through is not always what it is about: a Google
   News markets search carried an NSE/BSE story, which printed WORLD MARKETS on
   the card. Where the headline plainly says otherwise, it wins. */
const BY_CONTENT = [
  [/\b(sensex|nifty|nse|bse|rupee|rbi|dalal street)\b/i, 'INDIA MARKETS'],
  [/\b(bitcoin|btc|ethereum|eth|crypto|blockchain|stablecoin|solana|xrp)\b/i, 'CRYPTO NEWS'],
];

export function categoryFor(topic, headline) {
  if (headline) for (const [re, label] of BY_CONTENT) if (re.test(headline)) return label;
  return categoryForTopic(topic);
}

function categoryForTopic(topic) {
  switch (topic) {
    case 'crypto':        return 'CRYPTO NEWS';
    case 'markets-india': return 'INDIA MARKETS';
    case 'markets-world': return 'WORLD MARKETS';
    case 'business':      return 'BUSINESS';
    case 'india':         return 'INDIA';
    case 'world':         return 'WORLD NEWS';
    case 'tech':          return 'TECHNOLOGY';
    default:              return 'BREAKING NEWS';
  }
}

/* Attribution line. Names every outlet that carried it, which is both honest
   and a visible signal of how well corroborated the story is. */
export function sourceLine(sourceNames = []) {
  const names = sourceNames.filter(Boolean).slice(0, 3);
  if (!names.length) return 'DailyVolex';
  return names.join(' · ');
}
