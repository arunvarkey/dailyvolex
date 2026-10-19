/* Who actually reported a story.
 *
 * Everything on this channel rests on one number: how many independent outlets
 * carried a story. It is the corroboration check, it is printed on the card,
 * and it is the reader's reason to believe a headline from an account that
 * does no reporting of its own. So it has to be honest, and it was not.
 *
 * Real source lists from live runs:
 *
 *   5 sources  Economic Times · The Times of India · NDTV · Deccan Herald · Times of India
 *   2 sources  BBC News · BBC
 *   6 sources  Economic Times · Mint · Moneycontrol.com · Livemint · Yahoo Finance · Univest
 *
 * The same outlet under two spellings counted twice. Two mastheads owned by
 * one newsroom counted twice. Sites that republish other people's copy counted
 * as though they had confirmed anything. Three things are therefore folded
 * together here: spellings, ownership, and republishers.
 */

/* Spelling variants and group ownership, folded to one key per newsroom.
   Deliberately conservative: where two titles share a newsroom, they are one
   source, because one newsroom making one mistake is one mistake. */
const ALIASES = {
  // Bennett, Coleman & Co
  'times of india': 'times group', 'toi': 'times group',
  'economic times': 'times group', 'et now': 'times group',
  'etmarkets': 'times group', 'et': 'times group',
  // HT Media
  'mint': 'ht media', 'livemint': 'ht media', 'hindustan times': 'ht media',
  // Network18
  'moneycontrol': 'network18', 'news18': 'network18', 'cnn news18': 'network18',
  'firstpost': 'network18', 'cnbctv18': 'network18', 'cnbc tv18': 'network18',
  // Prasar Bharati, the state broadcaster: one newsroom, several outlets
  'news on air': 'prasar bharati', 'newsonair': 'prasar bharati',
  'dd india': 'prasar bharati', 'dd': 'prasar bharati',
  'all india radio': 'prasar bharati', 'air': 'prasar bharati',
  // The rest, spelling only
  'bbc': 'bbc', 'ndtv': 'ndtv', 'ndtv profit': 'ndtv',
  'hindu': 'the hindu', 'thehindu': 'the hindu',
  'indian express': 'indian express', 'financial express': 'indian express',
  'wsj': 'wall street journal', 'ft': 'financial times',
  'ap': 'associated press', 'pti': 'press trust of india',
};

/* Sites that carry other outlets' copy rather than reporting. A story
   appearing on all of them is one story that syndicated well, not a story
   several newsrooms stood behind. They are still named in the attribution —
   they did carry it — but they do not count as corroboration. */
const REPUBLISHERS = new Set([
  'yahoo finance', 'yahoo', 'msn', 'google news', 'news break', 'newsbreak',
  'sarkaritel', 'univest', 'investing', 'tradingview', 'stocktwits',
  'daijiworld', 'devdiscourse', 'latestly', 'zee business', 'bing news',
  'marketscreener', 'simply wall st', 'insider monkey', 'aol',
]);

/* Strip a masthead down to something comparable: "The Times of India",
   "Times of India" and "timesofindia.com" all have to land on one key. */
export function canonicalSource(name) {
  let s = String(name || '').toLowerCase().trim()
    .replace(/\.(com|in|co\.in|co\.uk|org|net|news)\b.*$/, '')
    .replace(/^the\s+/, '')
    .replace(/\s+news$/, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return ALIASES[s] || s;
}

export function isRepublisher(name) {
  return REPUBLISHERS.has(canonicalSource(name));
}

/* The corroboration figure: how many independent newsrooms carried this.
   Returns the republishers separately rather than hiding them — they belong
   in the attribution, just not in the count. */
export function independentSources(names = []) {
  const reporting = new Map();      // canonical key -> name as first seen
  const carried = [];

  for (const name of names) {
    if (!name) continue;
    const key = canonicalSource(name);
    if (!key) continue;
    if (REPUBLISHERS.has(key)) { if (!carried.includes(name)) carried.push(name); continue; }
    if (!reporting.has(key)) reporting.set(key, name);
  }

  return {
    count: reporting.size,
    names: [...reporting.values()],     // one name per newsroom, as written
    republishers: carried,
  };
}
