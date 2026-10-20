/* How much a story matters.
 *
 * Until now the ranking knew three things about a story: how many outlets
 * carried it, how fresh it was, and how much the feed was weighted. None of
 * those is about the story. So a heavily syndicated piece on a company buying
 * $22m of Bitcoin outranked a court ruling, and two of three top stories came
 * out crypto on a day when a cult leader was convicted of starving his
 * followers and Japan launched a mission to Mars.
 *
 * This is the missing piece: a hierarchy, the way a front page has one.
 *
 *   LEAD       what a front page leads with. Lives, power, the economy as a
 *              whole. An earthquake, a government falling, a rate decision.
 *   SIGNIFICANT  policy, law, diplomacy, regulators, companies at a scale
 *              that affects people who do not own their shares.
 *   NOTABLE    ordinary reported news. Most of a day.
 *   MINOR      incremental and vertical. A product launch, a share price, a
 *              coin moving. Real, occasionally interesting, never a lead.
 *
 * The rules below are deliberately readable rather than clever, because this
 * encodes editorial judgement and a judgement nobody can inspect is one
 * nobody can argue with.
 */

export const TIERS = { LEAD: 'lead', SIGNIFICANT: 'significant',
                       NOTABLE: 'notable', MINOR: 'minor' };

/* Points added to a story's score. The gaps are wide on purpose: importance
   has to beat corroboration, or a well-syndicated triviality wins again. */
export const TIER_POINTS = { lead: 10, significant: 6, notable: 3, minor: 0 };

/* ── LEAD ──────────────────────────────────────────────────────
   Lives, power, and the economy as a whole. */
const LEAD = [
  // Loss of life and mass harm
  /\b(killed|kills|dead|deaths?|death toll|casualties|massacre|genocide)\b/i,
  /\b(earthquake|tsunami|cyclone|hurricane|typhoon|wildfire|landslide|avalanche)\b/i,
  /\b(air ?strikes?|shelling|bombing|invasion|offensive|war (declared|breaks out))\b/i,
  /\b(famine|starv\w+|epidemic|pandemic|outbreak declared)\b/i,
  /\b(plane|train|bus|ferry|boat) (crash|collision|capsiz\w+)\b/i,
  /\b(terror attack|suicide bomb\w*|hostage|mass shooting)\b/i,
  // Power changing hands
  /\b(prime minister|president|chief minister|chancellor)\b[^.]*\b(resign\w*|quits?|steps down|sworn in|dies|died|ousted|impeach\w*)\b/i,
  /\b(government (falls|collapses)|no[- ]confidence|coup|martial law|state of emergency)\b/i,
  /\b(election results?|wins? (the )?election|exit polls?|sworn in as)\b/i,
  // The apex courts and the constitution
  /\b(supreme court|constitution bench)\b[^.]*\b(rules?|ruling|strikes? down|upholds?|orders?|verdict)\b/i,
  // The economy as a whole, not one company
  /\b(rbi|federal reserve|the fed|ecb|bank of england)\b[^.]*\b(cuts?|raises?|holds?|hikes?)\b[^.]*\b(rate|rates|repo)\b/i,
  /\b(union budget|budget 20\d\d|recession|sovereign default|currency collapse)\b/i,
  /\bnuclear\b[^.]*\b(test|strike|deal|threat)\b/i,
];

/* ── SIGNIFICANT ───────────────────────────────────────────────
   Policy, law, diplomacy, regulators, and companies at a scale that reaches
   beyond their own shareholders. */
const SIGNIFICANT = [
  /\b(parliament|lok sabha|rajya sabha|congress|senate|assembly)\b[^.]*\b(passes?|approves?|clears?|rejects?)\b/i,
  /\b(cabinet|government|ministry)\b[^.]*\b(approves?|announces?|bans?|bars?|blocks?|orders?|launches a scheme)\b/i,
  /\b(bars?|bans?|blocks?|restricts?|curbs?)\b[^.]*\b(agencies|imports?|exports?|companies|use of|access)\b/i,
  /\b(new law|legislation|ordinance|bill)\b/i,
  // A regulator acting is news even when the subject is a vertical.
  /\b(sec|cftc|rbi|sebi|fda|cci|ofcom|regulator|watchdog)\b[^.]*\b(approves?|rejects?|fines?|orders?|clears?|probes?|bans?)\b/i,
  /\b(sanctions?|tariffs?|export controls?|trade (deal|pact|agreement)|treaty)\b/i,
  /\b(summit|bilateral|state visit|diplomat\w+|ambassador|united nations|un security council)\b/i,
  /\b(high court|tribunal|court)\b[^.]*\b(rules?|orders?|convict\w+|acquits?|sentenc\w+)\b/i,
  /\b(investigation|probe|charges? (filed|framed)|indict\w+|arrest\w*)\b[^.]*\b(minister|official|chief|director|chairman|founder|executive|ceo)\b/i,
  /\b(charged|indicted|convicted|sentenced|arrested)\b[^.]*\b(with|of|over|for)\b[^.]*\b(fraud|bribery|corruption|laundering|conspiracy|theft)\b/i,
  /\b(strike|protests?|march|shutdown)\b[^.]*\b(thousands|nationwide|across)\b/i,
  /\b(vaccine|clinical trial|drug approval|breakthrough|mission to|spacecraft|launches? (a )?mission)\b/i,
  /\b(acquisition|merger|acquires?|takeover)\b/i,
  /\b(layoffs?|job cuts?|shuts? down (its )?(plant|factory|operations))\b/i,
  /\b(data breach|cyberattack|ransomware|outage)\b/i,
];

/* ── MINOR ─────────────────────────────────────────────────────
   Incremental and vertical. Never a lead, whatever the corroboration. */
const MINOR = [
  // One company's own news
  /\b(launches?|unveils?|introduc\w+|announces?|releases?|rolls? out|debuts?)\b[^.]*\b(new |its |the )?(product|app|model|version|feature|service|phone|chip|card|platform|tool)\b/i,
  // One company shipping a thing, named or not: "Apple launches iPhone 18
  // with satellite messaging". A mission launch is caught as significant
  // before this is reached, so "launches" alone is safe here.
  /\b(launch\w+|unveil\w+|introduc\w+|debut\w+)\b[^.]*\b(with|featuring|powered by|starting at)\b/i,
  /\b(launch\w+|unveil\w+|releases?)\b[^.]*\b(v?\d+(\.\d+)?|pro|max|ultra|plus)\b/i,
  /\b(partners? with|teams? up with|collaborat\w+ with)\b/i,
  /\b(appoints?|names?|hires?|promotes?)\b[^.]*\b(ceo|cto|cfo|head|director|chief)\b/i,
  // Share-price and market chatter
  /\b(shares?|stock)\b[^.]*\b(rise|rises|fall|falls|gain|gains|drop|drops|jump|jumps|slip|slips)\b/i,
  /\b(analysts?|brokerage|target price|rating|upgrade[sd]?|downgrade[sd]?)\b/i,
  /\b(52[- ]week (high|low)|all[- ]time high|market cap|trading volume)\b/i,
  // Incremental index moves — the chart story, not the economy story
  /\b(sensex|nifty|dow|nasdaq|ftse|nikkei)\b[^.]*\b\d+ points\b/i,
  // The daily market summary. "Wall Street closes lower for a third day" is
  // a session report, not news about the economy.
  /\b(wall street|markets?|stocks?|shares?|sensex|nifty|dow|nasdaq|ftse|nikkei|rupee|dollar)\b[^.]*\b(close[sd]?|closing|end(s|ed)?|open(s|ed)?|settle[sd]?|finish(es|ed)?)\b[^.]*\b(higher|lower|flat|up|down|gains?|losses?|red|green)\b/i,
];

/* Crypto is a vertical, not a beat. It belongs in Business on the days it is
   business news — a regulator acting, a fraud, a collapse, a law — and
   nowhere at all on the many days it is a price moving or one firm buying
   some. This is the rule that stops an account that is not a crypto account
   leading on Bitcoin three mornings a week. */
const CRYPTO = /\b(bitcoin|btc|ethereum|eth\b|crypto\w*|blockchain|stablecoin|altcoin|solana|xrp|dogecoin|memecoin|defi|nft|token(s|ised|ized)?|coinbase|binance|jpm coin)\b/i;

/* …unless the crypto story is actually a news story. */
const CRYPTO_MATTERS = [
  /\b(bans?|banned|ban on|outlaw\w*|legal tender)\b/i,
  /\b(sec|cftc|rbi|regulator|government|parliament|court|judge)\b/i,
  /\b(fraud|scam|hack(ed|ing)?|stolen|laundering|collapse[sd]?|bankrupt\w*|insolvent)\b/i,
  /\b(arrest\w*|charged|convict\w+|sentenc\w+|indict\w+|lawsuit|sues?)\b/i,
  /\b(etf approv\w+|approves? (a |the )?(spot )?etf)\b/i,
];

export function isCrypto(headline) {
  return CRYPTO.test(String(headline));
}

/* A crypto story that is only about crypto. */
export function isCryptoVertical(headline) {
  const h = String(headline);
  return CRYPTO.test(h) && !CRYPTO_MATTERS.some(re => re.test(h));
}

/* Scale of impact: a number of people, or money at a size that is a public
   fact rather than a company's quarter. Nudges a story up one tier. */
const BIG_SCALE = [
  /\b(thousands|millions|billions|lakh|crore|hundreds of)\b[^.]*\b(people|residents|workers|families|children|voters)\b/i,
  /\b(nationwide|across the country|countrywide|worldwide|global)\b/i,
];

export function tierOf(headline, { topic } = {}) {
  const h = String(headline || '');
  if (!h.trim()) return TIERS.MINOR;

  // A crypto-only story is capped at minor before anything else looks at it.
  // Without this, "Bitcoin crashes" matches a LEAD pattern via "crash".
  if (isCryptoVertical(h)) return TIERS.MINOR;

  if (LEAD.some(re => re.test(h))) return TIERS.LEAD;
  if (SIGNIFICANT.some(re => re.test(h))) return TIERS.SIGNIFICANT;
  if (MINOR.some(re => re.test(h))) return TIERS.MINOR;

  // Ordinary news, lifted a step when it plainly affects a lot of people.
  if (BIG_SCALE.some(re => re.test(h))) return TIERS.SIGNIFICANT;
  return TIERS.NOTABLE;
}

export function importancePoints(headline, opts) {
  return TIER_POINTS[tierOf(headline, opts)] ?? 0;
}
