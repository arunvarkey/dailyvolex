/* Does this headline say that something happened?
 *
 * Three live runs produced three different batches of non-stories — a video
 * index, a conference write-up, an explainer question, a school-assembly
 * listicle, "Future of Sustainable Aviation Fuel (SAF) Technology" — and each
 * time the answer was another regex. A blocklist enumerating everything that
 * is not news never converges: there is no end to the ways a thing can fail
 * to be a story, and every run finds new ones.
 *
 * So this asks the opposite question. A news headline reports an event, and
 * an event has a verb: kills, cuts, resigns, confirms, arrests. A feature
 * title is a noun phrase — "Future of Sustainable Aviation Fuel Technology",
 * "Global Health Research in the America First Era", "School assembly news
 * headlines today" — and has no verb at all. One test, and a whole class of
 * things stops getting through instead of three instances of it.
 *
 * The list is curated rather than clever, which is the honest description: it
 * is a list of things that happen. That means a real story with an unusual
 * verb can be refused, so this is not silent — every refusal is logged by
 * rule and shown in the approval issue, which is where a wrong rule becomes
 * visible to the person who can overrule it.
 */

/* Verbs that report an event. Written as stems; the inflections are
   generated, so adding a verb means adding one word. */
const STEMS = [
  // harm, conflict, disaster
  'kill', 'wound', 'injure', 'hurt', 'attack', 'bomb', 'shell', 'shoot', 'stab',
  'strike', 'raid', 'invade', 'besiege', 'capture', 'bombard', 'clash',
  'crash', 'collapse', 'derail', 'sink', 'erupt', 'flood', 'burn', 'explode',
  'destroy', 'damage', 'displace', 'evacuate', 'rescue', 'drown', 'trap',
  // law, state, politics
  'arrest', 'detain', 'charge', 'convict', 'acquit', 'sentence', 'jail',
  'free', 'release', 'sue', 'file', 'probe', 'investigate', 'indict',
  'ban', 'bar', 'block', 'veto', 'rule', 'order', 'approve', 'reject',
  'pass', 'vote', 'elect', 'appoint', 'name', 'nominate', 'resign', 'quit',
  'sack', 'dismiss', 'replace', 'sign', 'ratify', 'withdraw', 'impose',
  'lift', 'ease', 'tighten', 'allow', 'permit', 'grant', 'deny', 'refuse',
  'demand', 'threaten', 'warn', 'urge', 'accuse', 'deny', 'admit', 'confess',
  'protest', 'march', 'rally', 'boycott', 'summon', 'expel', 'deport',
  // money, markets, companies
  'cut', 'raise', 'hike', 'slash', 'lower', 'boost', 'rise', 'fall', 'jump',
  'plunge', 'surge', 'slide', 'climb', 'drop', 'gain', 'lose', 'exceed',
  'miss', 'post', 'report', 'earn', 'spend', 'invest', 'fund', 'buy', 'sell',
  'acquire', 'merge', 'float', 'list', 'launch', 'open', 'close', 'shut',
  'reopen', 'expand', 'shrink', 'hire', 'fire', 'lay', 'cancel', 'delay',
  'postpone', 'halt', 'suspend', 'resume', 'restore', 'recall', 'ship',
  'deliver', 'subscribe', 'settle', 'fine', 'repay', 'default',
  // saying and finding
  'say', 'tell', 'announce', 'confirm', 'reveal', 'unveil', 'disclose',
  'find', 'discover', 'identify', 'detect', 'show', 'prove', 'suggest',
  'agree', 'decide', 'plan', 'propose', 'offer', 'seek', 'call', 'ask',
  'meet', 'visit', 'hold', 'host', 'attend', 'join', 'leave', 'return',
  // everyday events
  'die', 'win', 'beat', 'defeat', 'score', 'set', 'hit', 'break', 'reach',
  'start', 'begin', 'end', 'stop', 'continue', 'face', 'back', 'oppose',
  'support', 'help', 'save', 'take', 'give', 'send', 'receive', 'seize',
  'move', 'push', 'mark', 'honour', 'honor', 'award', 'mourn', 'bury',
  'spread', 'infect', 'recover', 'treat', 'test', 'vaccinate', 'declare',
  'stand', 'step', 'flee', 'escape', 'surrender', 'arrive', 'land', 'launch',
  'target', 'curb', 'limit', 'cap', 'restrict', 'link', 'blame', 'praise',
  'criticise', 'criticize', 'condemn', 'defend', 'build', 'reach', 'deploy',
  // Added after a real market headline was refused — "Rupee steadies against
  // the dollar" — and a real one about the cabinet: "Cabinet clears port
  // expansion scheme". The list is the rule, so the list has to carry the
  // ordinary vocabulary of a news page.
  'clear', 'steady', 'strengthen', 'weaken', 'firm', 'soften', 'rebound',
  'rally', 'retreat', 'trade', 'hover', 'slip', 'edge', 'tumble', 'soar',
  'spike', 'dip', 'extend', 'trim', 'pare', 'slump', 'stall', 'dive',
  'issue', 'publish', 'introduce', 'present', 'submit', 'hand', 'allocate',
  'vow', 'pledge', 'promise', 'commit', 'press', 'insist', 'stress',
  'argue', 'claim', 'allege', 'state', 'note', 'cite', 'add', 'flag',
  'lead', 'head', 'chair', 'oversee', 'run', 'stage', 'conduct',
  'suffer', 'endure', 'survive', 'succumb', 'retire', 'succeed',
  'grow', 'double', 'triple', 'halve', 'axe', 'outlaw',
  'appeal', 'challenge', 'contest', 'overturn', 'uphold', 'proclaim',
  'qualify', 'advance', 'eliminate', 'knock', 'ink', 'restart', 'nab',
  // Found by reading what the rule refused on its first live run, where it
  // threw out "Haitian migrants changed this US town", "how they are
  // deepening defence ties" and "Israeli settlers have Palestinians
  // surrounded". The list being incomplete is the known cost of this rule;
  // the refusal log is how the cost stays visible.
  'change', 'deepen', 'surround', 'cost', 'shift', 'turn', 'split',
  'unite', 'divide', 'overhaul', 'revamp', 'scrap', 'abolish', 'merge',
];

/* Irregular forms, which no rule would produce. */
const IRREGULAR = {
  say: ['said'], tell: ['told'], find: ['found'], hold: ['held'], held: [],
  buy: ['bought'], sell: ['sold'], leave: ['left'], flee: ['fled'],
  shoot: ['shot'], stand: ['stood'], take: ['took', 'taken'],
  give: ['gave', 'given'], send: ['sent'], hit: ['hit'], set: ['set'],
  cut: ['cut'], beat: ['beat', 'beaten'], rise: ['rose', 'risen'],
  fall: ['fell', 'fallen'], win: ['won'], lose: ['lost'], break: ['broke', 'broken'],
  begin: ['began', 'begun'], strike: ['struck'], seek: ['sought'],
  lay: ['laid'], free: ['freed'], die: ['died', 'dying'], flee_: [],
  withdraw: ['withdrew', 'withdrawn'], sink: ['sank', 'sunk'],
  burn: ['burnt'], spread: ['spread'], bar: ['barred'],
};

function inflect(stem) {
  const out = new Set([stem]);
  // third person
  out.add(/(s|x|z|ch|sh)$/.test(stem) ? stem + 'es'
        : /[^aeiou]y$/.test(stem) ? stem.slice(0, -1) + 'ies'
        : stem + 's');
  // past and participle
  if (stem.endsWith('e')) out.add(stem + 'd');
  else if (/[^aeiou]y$/.test(stem)) out.add(stem.slice(0, -1) + 'ied');
  else out.add(stem + 'ed');
  // present participle
  out.add(stem.endsWith('e') ? stem.slice(0, -1) + 'ing' : stem + 'ing');
  for (const extra of IRREGULAR[stem] || []) out.add(extra);
  return out;
}

export const NEWS_VERBS = new Set();
for (const stem of STEMS) for (const form of inflect(stem)) NEWS_VERBS.add(form);

/* Things that are grammatically verbs but report nothing: somebody sharing a
   link, an article "highlighting" something. "PM Modi shares an article
   highlighting technology and research" went out as a TECHNOLOGY story. */
const EMPTY = [
  /\b(shares?|shared|posts?|posted|tweets?|retweets?)\s+(an?|the|his|her|their)\s+(article|post|photo|video|message|link|note)\b/i,
  /\b(highlighting|showcasing|featuring|exploring|discussing)\b/i,
  /\breacts? to\b/i,
];

export function reportsNothing(title) {
  return EMPTY.some(re => re.test(String(title)));
}

/* Does the headline contain a word that names something happening? */
export function hasNewsVerb(title) {
  const words = String(title || '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/[\s'-]+/)
    .filter(Boolean);
  return words.some(w => NEWS_VERBS.has(w));
}

/* The positive test: this headline reports an event.
 *
 * Deliberately the only place that says yes. Everything else in the editorial
 * rules says no to something specific; this one has to be satisfied before
 * any of that matters.
 */
export function looksLikeNews(title, { quoted = false } = {}) {
  const t = String(title || '').trim();
  if (!t) return false;
  if (reportsNothing(t)) return false;
  // A headline that attributes itself to somebody is reporting what they
  // said, and saying something is an event. "Team Trump's Tariffs, Visa
  // Curbs Not Targeted At India: Marco Rubio" has no finite verb in it at
  // all. The caller decides whether it is attributed, because working that
  // out lives in select.mjs and this file must not depend on it.
  if (quoted) return true;
  return hasNewsVerb(t);
}
