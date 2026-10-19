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

/* Being in a finance outlet's feed does not make a story finance news: a
   crypto site's tech section put "Claude cracks a 25-year NSA number mystery"
   straight into the shortlist. A story has to actually be about markets,
   money, companies or policy to belong on this channel. */
const TOPICAL = [
  // markets and instruments
  'market','markets','stock','stocks','share','shares','equity','equities','index','indices',
  'bond','bonds','yield','yields','commodity','commodities','oil','gold','futures','etf','ipo',
  'nasdaq','dow','s&p','sensex','nifty','ftse','nikkei','forex','currency','dollar','rupee','euro','yen',
  // crypto
  'bitcoin','btc','ethereum','eth','crypto','cryptocurrency','blockchain','token','tokens','stablecoin',
  'defi','exchange','mining','miner','wallet','altcoin','solana','xrp','binance','coinbase','custody',
  // money and policy
  'fed','federal reserve','rbi','ecb','central bank','rate','rates','inflation','cpi','gdp','recession',
  'tariff','tax','budget','stimulus','debt','deficit','regulator','regulation','sec','cftc','lawsuit',
  'settlement','fine','ban','approval','approves','licence','license',
  // corporate and money flows
  'earnings','revenue','profit','loss','losses','merger','acquisition','acquires','funding','raise',
  'raises','valuation','billion','million','trillion','investor','investors','fund','bank','banking',
  'price','prices','surge','plunge','rally','rallies','slump','soars','tumbles','jumps','falls',
];

/* Stock tips are not news. "Analyst recommends 3 stocks to buy" is somebody's
   advice with a price target attached, and putting it out under a news
   channel's name is both weak editorially and uncomfortably close to passing
   on financial advice. */
const TIPS = /\b(recommends?|top picks?|stocks? to (buy|watch|sell)|buy or sell|target price|should you (buy|invest)|multibagger|best stocks?|these \d+ stocks?)\b/i;

/* Price speculation is not news either. "Can ETH get back to $3,000?" reports
   nothing that happened — it is a guess with a question mark, and a news
   channel that runs guesses starts being read as one.

   Deliberately narrow: an institution forecasting something IS news ("Fed
   forecasts two more cuts"), so only speculative framing is caught, not the
   word "forecast". */
const SPECULATION = [
  /\bprice prediction\b/i,
  /\bprediction[s]?\s*[:?]/i,
  /\bcan \w+ (hit|reach|get back to|break|top|return to)\b/i,
  /\bwill \w+ (hit|reach|crash|soar|rally|double|plunge|moon)\b/i,
  /\b(could|might|may) (hit|reach|soar|crash|plunge|double|rally to)\b/i,
  /\bwhat'?s next for\b/i,
  /\bwhere (is|will) \w+ (headed|head|go)\b/i,
  /\bhow (high|low) (can|will|could)\b/i,
  /\bwhy (is|are|did|has) \w+ (stock|share|price)?\s*(gaining|falling|rising|dropping|surging|crashing)\b/i,
  /\bby (the end of )?20\d\d\?/i,
  // Not "outlook for 2027": an institution revising its outlook is news, and
  // "IMF cuts global growth outlook for 2027" is exactly the kind of story
  // this channel exists to carry.
];

export function isSpeculation(title) {
  return SPECULATION.some(re => re.test(String(title)));
}

export function isAdvice(title) {
  return TIPS.test(String(title)) || isSpeculation(title);
}

/* Not news, whatever section it came from. Broadening the feeds means taking
   whatever a front page carries, and a front page carries a lot of this. */
const JUNK = [
  /\bhoroscope|astrology|zodiac|rashifal\b/i,
  /\brecipe|how to (cook|make)\b/i,
  /\b(deals?|offers?|discount|sale) (on|of|live|today)\b/i,
  /\bbest \d+ (phones?|laptops?|gadgets?|gifts?)\b/i,
  /\b(photos?|pics?|images?|in pictures)\s*[:|]/i,
  /\bviral video|watch:|caught on camera\b/i,
  /\b(wedding|birthday|dating|girlfriend|boyfriend|divorce) (photos?|pics?|rumou?rs?)\b/i,
  /\bquiz|crossword|puzzle\b/i,
  /\bdaily (digest|briefing) for\b/i,
];

export function isJunk(title) {
  return JUNK.some(re => re.test(String(title)));
}

export function isTopical(title) {
  const t = ' ' + String(title).toLowerCase().replace(/[^a-z0-9$&. ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  // A currency amount is itself a strong signal: "$5M settlement", "₹2,000 crore".
  if (/[$€£₹]\s?\d/.test(title)) return true;
  return TOPICAL.some(w => t.includes(' ' + w + ' '));
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

    // Corroboration still dominates — it is the safety check, not a taste
    // setting — but outlet weight now carries enough to separate stories that
    // are otherwise level.
    const score = (sources * 2) + (freshnessScore(newest, now) * 1.5) + ((weight - 1) * 2);

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

/* Crypto, India markets and world markets are three topics but one beat: to
   anyone scrolling, a post made of all three is a finance post. Capping by
   topic alone let that happen — INDIA MARKETS, INDIA MARKETS, CRYPTO NEWS —
   so beats are capped too. */
const BEATS = {
  crypto: 'markets', 'markets-india': 'markets', 'markets-world': 'markets',
  business: 'general', india: 'general', world: 'general', tech: 'general',
};
const beatOf = topic => BEATS[topic] || 'general';

export function selectStories(items, { history = [], count = 3, now = Date.now(),
                                       minSources = 1, maxAgeHours = 24,
                                       maxPerTopic = 2, maxPerBeat = 2 } = {}) {
  const cutoff = now - maxAgeHours * 3600000;
  const fresh = items
    .filter(i => !i.published || i.published >= cutoff)
    // The finance gate belongs only on finance feeds, whose tech and lifestyle
    // sections would otherwise leak in. A general news feed carries general
    // news by definition, and gating it on market words would throw away most
    // of what it is there for.
    .filter(i => (i.requireTopical ? isTopical(i.title) : true))
    .filter(i => !isAdvice(i.title))
    .filter(i => !isJunk(i.title));

  const ranked = rankClusters(cluster(fresh), { now });
  const chosen = [];
  const takenTitles = [];
  const perTopic = new Map();
  const perBeat = new Map();

  const eligible = c =>
    c.sources >= minSources
    && !isRepeat(c.lead.title, history)
    && !isRepeat(c.lead.title, takenTitles.map(t => ({ title: t })));

  const take = c => {
    chosen.push(c);
    takenTitles.push(c.lead.title);
    perTopic.set(c.lead.topic, (perTopic.get(c.lead.topic) || 0) + 1);
    const b = beatOf(c.lead.topic);
    perBeat.set(b, (perBeat.get(b) || 0) + 1);
  };

  // First pass caps each topic, so a busy day in crypto does not push India
  // and world markets off a post that covers all three. Three stories about
  // the same subject read as one story told three times.
  for (const c of ranked) {
    if (chosen.length >= count) break;
    if ((perTopic.get(c.lead.topic) || 0) >= maxPerTopic) continue;
    if ((perBeat.get(beatOf(c.lead.topic)) || 0) >= maxPerBeat) continue;
    if (eligible(c)) take(c);
  }

  // Then fill any remaining slots without the cap, rather than posting fewer
  // stories than asked for on a quiet day.
  for (const c of ranked) {
    if (chosen.length >= count) break;
    if (chosen.includes(c)) continue;
    if (eligible(c)) take(c);
  }

  return chosen;
}
