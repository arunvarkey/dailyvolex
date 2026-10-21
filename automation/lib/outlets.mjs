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

/* ── Who owns the newsroom ─────────────────────────────────────
 *
 * Counting newsrooms was the first half. The second half is that three Indian
 * mastheads owned by three conglomerates, all of them with large businesses
 * the government regulates, are not three independent checks on a story in the
 * way Reuters, the Associated Press and a trust-owned paper are. Ownership is
 * a fact about a source, and the reader is entitled to it.
 *
 * `funding` is the part that actually matters for independence:
 *   conglomerate  owned inside a large commercial group with other interests
 *   commercial    a media company, listed or private, media is the business
 *   trust         a trust or foundation holds it, structurally insulated
 *   cooperative   owned by its members, who are other newsrooms
 *   state         funded by a government, at whatever arm's length
 *   reader        subscriptions and donations, no large owner
 *
 * None of these labels is a verdict. A state broadcaster can be excellent and
 * a reader-funded site can be careless. They are stated so the reader can
 * weigh a story carried by one kind of outlet only.
 *
 * Sourced from company filings and Reporters Without Borders' India country
 * profile. Ownership moves — this register needs checking, not trusting.
 */
export const OWNERS = {
  // ── India ──
  'times group':      { owner: 'Bennett, Coleman & Co',      funding: 'conglomerate', country: 'IN' },
  'ht media':         { owner: 'HT Media / KK Birla family', funding: 'conglomerate', country: 'IN' },
  'network18':        { owner: 'Reliance Industries',        funding: 'conglomerate', country: 'IN' },
  'ndtv':             { owner: 'Adani Group',                funding: 'conglomerate', country: 'IN' },
  'zee':              { owner: 'Essel Group',                funding: 'conglomerate', country: 'IN' },
  'india today':      { owner: 'Living Media',               funding: 'commercial',   country: 'IN' },
  'the hindu':        { owner: 'The Hindu Group (family-held)', funding: 'commercial', country: 'IN' },
  'indian express':   { owner: 'Indian Express Group',       funding: 'commercial',   country: 'IN' },
  'deccan herald':    { owner: 'Printers (Mysore)',          funding: 'commercial',   country: 'IN' },
  'telegraph india':  { owner: 'ABP Group',                  funding: 'commercial',   country: 'IN' },
  'business standard':{ owner: 'Business Standard Pvt Ltd',  funding: 'commercial',   country: 'IN' },
  'prasar bharati':   { owner: 'Government of India',        funding: 'state',        country: 'IN' },
  'press trust of india': { owner: 'PTI (newspaper cooperative)', funding: 'cooperative', country: 'IN' },
  'ani':              { owner: 'ANI Media Pvt Ltd',          funding: 'commercial',   country: 'IN' },
  'the wire':         { owner: 'Foundation for Independent Journalism', funding: 'reader', country: 'IN' },
  'scroll':           { owner: 'Scroll Media',               funding: 'reader',       country: 'IN' },
  'newslaundry':      { owner: 'Newslaundry Media',          funding: 'reader',       country: 'IN' },

  // ── International ──
  'reuters':          { owner: 'Thomson Reuters (Trust Principles)', funding: 'trust', country: 'GB' },
  'associated press': { owner: 'AP (member cooperative)',    funding: 'cooperative',  country: 'US' },
  'agence france presse': { owner: 'AFP',                    funding: 'cooperative',  country: 'FR' },
  'bbc':              { owner: 'BBC (licence fee)',          funding: 'state',        country: 'GB' },
  'al jazeera':       { owner: 'Government of Qatar',        funding: 'state',        country: 'QA' },
  'deutsche welle':   { owner: 'Government of Germany',      funding: 'state',        country: 'DE' },
  'guardian':         { owner: 'Scott Trust',                funding: 'trust',        country: 'GB' },
  'the guardian':     { owner: 'Scott Trust',                funding: 'trust',        country: 'GB' },
  'financial times':  { owner: 'Nikkei',                     funding: 'commercial',   country: 'GB' },
  'wall street journal': { owner: 'News Corp',               funding: 'conglomerate', country: 'US' },
  'new york times':   { owner: 'New York Times Company',     funding: 'commercial',   country: 'US' },
  'bloomberg':        { owner: 'Bloomberg LP',               funding: 'conglomerate', country: 'US' },
  'cnbc':             { owner: 'Comcast / NBCUniversal',     funding: 'conglomerate', country: 'US' },
  'cnn':              { owner: 'Warner Bros. Discovery',     funding: 'conglomerate', country: 'US' },
};

const UNKNOWN_OWNER = { owner: null, funding: 'unknown', country: null };

export function ownerOf(name) {
  return OWNERS[canonicalSource(name)] || UNKNOWN_OWNER;
}

/* Sites that carry other outlets' copy rather than reporting, and wires that
   print whatever was paid for. A story appearing on all of them is one story
   that syndicated well, not a story several newsrooms stood behind. They are
   still named in the attribution — they did carry it — but they do not count
   as corroboration. */
const NOT_NEWSROOMS = [
  'yahoo finance', 'yahoo', 'msn', 'google news', 'news break', 'newsbreak',
  'sarkaritel', 'univest', 'investing', 'tradingview', 'stocktwits',
  'daijiworld', 'devdiscourse', 'latestly', 'zee business', 'bing news',
  'marketscreener', 'simply wall st', 'insider monkey', 'aol',
  'prnewswire', 'pr newswire', 'businesswire', 'business wire',
  'globenewswire', 'globe newswire', 'accesswire', 'einpresswire', 'prweb',
];

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

/* Held in canonical form, which is the whole point: canonicalSource strips a
   trailing " news", so "Google News" became "google" and never matched the
   entry spelled "google news". Google News was being counted as an
   independent newsroom standing behind stories — silently inflating the one
   number this channel is built on. Canonicalising the list fixes it for
   "Bing News" too, and for whatever is added later in whichever spelling.
   Built after canonicalSource is declared, because it calls it. */
const REPUBLISHERS = new Set(NOT_NEWSROOMS.map(canonicalSource));

export function isRepublisher(name) {
  const key = canonicalSource(name);
  if (REPUBLISHERS.has(key)) return true;
  // A company's blog reporting on that company is not a second newsroom
  // agreeing — it is the subject speaking. blog.google was corroborating a
  // story about a Google report.
  return /^blog\b/.test(key) || /\bnewsroom$/.test(key);
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
    // Through isRepublisher, not the set directly: the set cannot know about
    // a corporate blog or a company newsroom, and asking the set was how
    // blog.google came to corroborate a story about a Google report.
    if (isRepublisher(name)) { if (!carried.includes(name)) carried.push(name); continue; }
    if (!reporting.has(key)) reporting.set(key, name);
  }

  const profiles = [...reporting.keys()].map(k => ({ key: k, ...(OWNERS[k] || UNKNOWN_OWNER) }));
  // Distinct owners, not distinct mastheads. Three Indian conglomerates are
  // three owners; three titles belonging to one of them is one.
  const owners = new Set(profiles.map(p => p.owner).filter(Boolean));
  const countries = new Set(profiles.map(p => p.country).filter(Boolean));
  const fundings = new Set(profiles.map(p => p.funding).filter(f => f && f !== 'unknown'));

  return {
    count: reporting.size,
    names: [...reporting.values()],     // one name per newsroom, as written
    republishers: carried,
    // ── Ownership, as a fact about the sources rather than a verdict ──
    owners: [...owners],
    ownerCount: owners.size,
    countries: [...countries],
    fundings: [...fundings],
    unknownOwners: profiles.filter(p => !p.owner).length,
  };
}

/* Is the corroboration all of one kind?
 *
 * Three mastheads owned by three conglomerates in one country, every one of
 * them with large businesses that government regulates, is not the same check
 * on a story as Reuters, the Associated Press and a trust-owned paper. This
 * does not say the story is wrong — it says what the agreement is worth, and
 * it belongs in front of whoever is approving the post.
 *
 * Says nothing at all when only one or two outlets carry a story: that is
 * already flagged as thin corroboration, and two more warnings about the same
 * two outlets is noise.
 */
export function concentrationWarnings(sources = []) {
  const s = independentSources(sources);
  const out = [];
  if (s.count < 2) return out;             // thin corroboration is flagged already

  const known = s.count - s.unknownOwners;

  if (known >= 2 && s.ownerCount === 1)
    out.push(`All ${known} outlets carrying this share one owner (${s.owners[0]}).`);

  if (known >= 3 && s.countries.length === 1 && s.fundings.length === 1
      && s.fundings[0] === 'conglomerate')
    out.push(`Every outlet carrying this is a ${s.countries[0]} conglomerate-owned newsroom —`
      + ` no wire service, trust-owned or reader-funded outlet has it.`);

  // Two governments' broadcasters agreeing is corroboration; one government's
  // outlets agreeing with themselves is not.
  if (known >= 2 && s.fundings.length === 1 && s.fundings[0] === 'state'
      && s.countries.length === 1)
    out.push(`Only ${s.countries[0]} state-funded outlets are carrying this`
      + ` (${s.names.join(', ')}).`);

  if (s.count >= 3 && s.unknownOwners === s.count)
    out.push(`No ownership is recorded for any outlet carrying this —`
      + ` the corroboration cannot be checked for independence.`);

  return out;
}
