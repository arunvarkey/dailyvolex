#!/usr/bin/env node
/* Tests for the parts where a bug would put something wrong on the account.
 *   node automation/test.mjs
 */

import { parseFeed } from './lib/rss.mjs';
import { similarity, cluster, selectStories, selectSections, isRepeat, isTopical, isAdvice,
         isSpeculation, isJunk, isPressRelease, rankClusters } from './lib/select.mjs';
import { sectionOf, sectionLabel, SECTIONS } from './lib/sections.mjs';
import { makeHeadline, tidy, sourceLine, categoryFor } from './lib/headline.mjs';
import { canonicalSource, isRepublisher, independentSources } from './lib/outlets.mjs';
import { buildCaption } from './caption.mjs';
import { isUsable, pickBest, creditFor, subjectFor, findImage, backdropFor, isSensitive,
         queriesFor, entitiesFrom, isTitleCase, relevance, prefersChart } from './lib/imagery.mjs';

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? `  [${detail}]` : ''}`); }
};

const feed = { id: 'f', name: 'Test', topic: 'crypto', weight: 1 };
const hoursAgo = h => new Date(Date.now() - h * 3600000).toUTCString();

/* ── Feed reading ─────────────────────────────────────────────── */

const xml = `<rss><channel>
  <item><title><![CDATA[Bitcoin tops $90,000 &amp; holds]]></title>
    <link>https://e.com/1</link><pubDate>${hoursAgo(1)}</pubDate></item>
  <item><title>Plain &lt;b&gt;title&lt;/b&gt; here</title>
    <link>https://e.com/2</link><pubDate>not a date</pubDate></item>
</channel></rss>`;

const items = parseFeed(xml, feed);
ok('reads items from a feed', items.length === 2, `got ${items.length}`);
ok('decodes entities', items[0].title === 'Bitcoin tops $90,000 & holds', items[0].title);
ok('strips markup from titles', items[1].title === 'Plain title here', items[1].title);
ok('an unparseable date is treated as old, not as now', items[1].published === 0);
ok('survives junk input', parseFeed('not xml at all', feed).length === 0);
ok('survives empty input', parseFeed('', feed).length === 0 && parseFeed(null, feed).length === 0);

/* ── Aggregators must not inflate the source count ────────────── */

const gnews = { id:'g', name:'Google News', topic:'crypto', weight:1, aggregator:true };
const gxml = `<rss><channel>
  <item><title>Bitcoin Price and Deutsche Bank's Crypto Custody Start - CryptoTicker</title>
    <link>https://news.google.com/x</link><pubDate>${hoursAgo(1)}</pubDate></item>
  <item><title>Fed holds rates steady — Reuters</title>
    <link>https://news.google.com/y</link><pubDate>${hoursAgo(1)}</pubDate></item>
  <item><title>A headline with no publisher attached</title>
    <link>https://news.google.com/z</link><pubDate>${hoursAgo(1)}</pubDate></item>
</channel></rss>`;
const gitems = parseFeed(gxml, gnews);
ok('the real publisher replaces the aggregator', gitems[0].source === 'CryptoTicker', gitems[0].source);
ok('the publisher suffix is stripped from the title',
  gitems[0].title === "Bitcoin Price and Deutsche Bank's Crypto Custody Start", gitems[0].title);
ok('an em-dash publisher is handled too', gitems[1].source === 'Reuters', gitems[1].source);
ok('a title with no publisher is left alone',
  gitems[2].source === 'Google News' && gitems[2].title === 'A headline with no publisher attached');
ok('a non-aggregator feed keeps its own name', parseFeed(gxml, feed)[0].source === 'Test');

// The reason this matters: one outlet syndicated through an aggregator used to
// score as two independent sources.
const syndicated = [
  { title: 'Fed holds rates steady', source: 'Reuters', published: Date.now(), weight: 1, topic: 'world' },
  ...parseFeed(`<rss><channel><item><title>Fed holds rates steady — Reuters</title>
    <pubDate>${hoursAgo(1)}</pubDate></item></channel></rss>`, gnews),
];
ok('a syndicated copy does not count as corroboration',
  rankClusters(cluster(syndicated))[0].sources === 1,
  `${rankClusters(cluster(syndicated))[0].sources} sources`);

/* ── Off-topic stories are kept out ───────────────────────────── */

ok('a finance story is topical', isTopical('CFTC Wants to Drop Gemini\u2019s $5M Settlement'));
ok('a tech story in a crypto feed is not',
  !isTopical('\u2018Wow, it\u2019s a real discovery\u2019: Claude cracks a 25-year NSA number mystery'));
ok('entertainment is not', !isTopical('Taylor Swift announces new album tour dates'));
ok('a currency amount alone is enough', isTopical('Startup raises \u20b92,000 crore in fresh round'));
// The finance gate applies to finance feeds, which is where off-topic leaks in.
ok('a finance feed cannot leak an off-topic story',
  !selectStories([
    { title: 'Claude cracks a 25-year NSA number mystery', source:'A', published: Date.now(), weight:1, topic:'crypto', requireTopical:true },
    { title: 'Claude cracks a 25-year NSA number mystery, say researchers', source:'B', published: Date.now(), weight:1, topic:'crypto', requireTopical:true },
  ], { count: 3, now: Date.now() }).length);
// A general news feed is not gated on market words — that is the point of it.
ok('a general feed may carry general news',
  selectStories([
    { title: 'Prime Minister announces new education policy', source:'A', published: Date.now(), weight:1, topic:'india' },
    { title: 'Prime Minister unveils education policy reforms', source:'B', published: Date.now(), weight:1, topic:'india' },
  ], { count: 3, now: Date.now() }).length === 1);
ok('junk never reaches the shortlist, whatever the feed',
  !selectStories([
    { title: 'Horoscope today: what the stars say for your sign', source:'A', published: Date.now(), weight:1, topic:'india' },
    { title: 'Horoscope today: what the stars hold for your sign', source:'B', published: Date.now(), weight:1, topic:'india' },
  ], { count: 3, now: Date.now() }).length);

/* ── Stock tips are not news ──────────────────────────────────── */

ok('an analyst recommendation is refused',
  isAdvice('Vaishali Parekh recommends 3 stocks to buy today'));
ok('a target-price piece is refused', isAdvice('HDFC Bank target price raised to Rs 2,000'));
ok('a multibagger piece is refused', isAdvice('This multibagger stock gained 300% in a year'));
ok('a price prediction is refused',
  isAdvice('Ethereum Price Prediction: Can ETH Get Back to $3,000 Before the End of 2026?'));
ok('a "will it hit" piece is refused', isAdvice('Will Bitcoin hit $150,000 this cycle?'));
ok('a "what next for" piece is refused',
  isAdvice("What's next for IDBI Bank stock after Q2 net profit jumps"));
ok('a "how high can it go" piece is refused', isAdvice('How high can gold go from here?'));
// An institution revising its forecast IS news, and must survive the filter.
ok('an institutional forecast is kept', !isAdvice('Fed forecasts two more rate cuts this year'));
ok('an outlook revision is kept', !isAdvice('IMF cuts global growth outlook for 2027'));

ok('actual news is not refused',
  !isAdvice('ICICI Bank Q2 profit jumps 20% to Rs 14,800 crore')
  && !isAdvice('Federal Reserve cuts interest rates'));
ok('advice never reaches the shortlist', (() => {
  const t = Date.now();
  return !selectStories([
    { title:'Analyst recommends 3 stocks to buy this week', source:'A', published:t, weight:1, topic:'india' },
    { title:'Analyst recommends 3 stocks to buy this week now', source:'B', published:t, weight:1, topic:'india' },
  ], { count:3, now:t }).length;
})());

/* ── Entities must not run across punctuation ─────────────────── */

ok('two companies in a list are not merged into one',
  !queriesFor('Buy these: Coforge, Lalithaa Jewellery and Titan')
    .some(q => /Coforge Lalithaa/.test(q)),
  JSON.stringify(queriesFor('Buy these: Coforge, Lalithaa Jewellery and Titan')));
ok('a long opening clause is cut to a name-sized query',
  queriesFor('Black Monday Fears Grip Wall Street as Traders Lose Nerve')[0]
    .split(' ').length <= 3,
  queriesFor('Black Monday Fears Grip Wall Street as Traders Lose Nerve')[0]);

/* ── Matching the same story across outlets ───────────────────── */

ok('matches the same story worded differently',
  similarity('Federal Reserve cuts rates by 25 basis points',
             'BREAKING: Federal Reserve cuts interest rates 25 bps') > 0.5);
ok('does not match unrelated stories',
  similarity('Bitcoin tops $90,000', 'India launches new CBDC pilot in five cities') < 0.3);

const mixed = [
  { title: 'Fed cuts rates by 25 basis points', source: 'A', published: Date.now(), weight: 1, topic: 'world' },
  { title: 'Federal Reserve cuts rates 25 bps',  source: 'B', published: Date.now(), weight: 1, topic: 'world' },
  { title: 'Solana ETF approved by regulators',  source: 'C', published: Date.now(), weight: 1, topic: 'crypto' },
];
ok('groups one story and leaves the other alone', cluster(mixed).length === 2);

/* ── What gets chosen ─────────────────────────────────────────── */

const now = Date.now();
const pool = [
  { title: 'Fed cuts rates by 25 basis points', source: 'A', published: now, weight: 1, topic: 'world' },
  { title: 'Federal Reserve cuts rates 25 bps',  source: 'B', published: now, weight: 1, topic: 'world' },
  { title: 'Fed lowers interest rates 25 basis points', source: 'C', published: now, weight: 1, topic: 'world' },
  { title: 'Obscure altcoin might possibly moon soon', source: 'D', published: now, weight: 1, topic: 'crypto' },
  { title: 'Very old news about something', source: 'A', published: now - 80 * 3600000, weight: 1, topic: 'world' },
];

const picked = selectStories(pool, { count: 2, now });
ok('the best-corroborated story is picked first',
  /fed|federal/i.test(picked[0].lead.title) && picked[0].sources === 3,
  `${picked[0]?.lead.title} (${picked[0]?.sources} sources)`);
ok('stale stories are excluded',
  !picked.some(c => /very old/i.test(c.lead.title)));
ok('two near-identical stories are not both picked',
  new Set(picked.map(c => c.lead.title)).size === picked.length);

const history = [{ title: 'Federal Reserve cuts interest rates by 25 basis points' }];
ok('a story already posted is not offered again',
  !selectStories(pool, { count: 3, now, history }).some(c => /fed|federal/i.test(c.lead.title)));
ok('repeat detection ignores wording differences',
  isRepeat('Fed cuts rates 25bps', [{ title: 'Federal Reserve cuts rates by 25 basis points' }]));

/* ── A post should not be one subject three times ─────────────── */

const lopsided = [
  { title:'Bitcoin tops $90,000 on ETF inflows',       source:'A', published:now, weight:1, topic:'crypto' },
  { title:'Ethereum rallies as staking yields climb',   source:'B', published:now, weight:1, topic:'crypto' },
  { title:'Solana ETF approved by regulators today',    source:'C', published:now, weight:1, topic:'crypto' },
  { title:'Sensex climbs 540 points to a record high',  source:'D', published:now, weight:1, topic:'india'  },
];
const spread = selectStories(lopsided, { count: 3, now });
ok('one topic cannot take every slot',
  spread.filter(c => c.lead.topic === 'crypto').length <= 2,
  spread.map(c => c.lead.topic).join(','));
ok('another topic gets in',
  spread.some(c => c.lead.topic === 'india'),
  spread.map(c => c.lead.topic).join(','));

// Crypto, India markets and world markets are one beat to a reader.
const allFinance = [
  { title:'Sensex tumbles 876 points as banks drag',   source:'A', published:now, weight:1.1, topic:'markets-india' },
  { title:'Sensex falls 876 points dragged by lenders', source:'B', published:now, weight:1,   topic:'markets-india' },
  { title:'Sensex drops 876 points on bank selling',    source:'C', published:now, weight:1,   topic:'markets-india' },
  { title:'Bitcoin ETFs see heavy weekly outflows',     source:'D', published:now, weight:1.2, topic:'crypto' },
  { title:'Bitcoin ETF outflows run for a second week', source:'E', published:now, weight:1,   topic:'crypto' },
  { title:'Wall Street closes lower for a third day',   source:'F', published:now, weight:1.3, topic:'markets-world' },
  { title:'Wall Street ends lower for a third session', source:'G', published:now, weight:1,   topic:'markets-world' },
  { title:'Ceasefire talks resume in Geneva',           source:'H', published:now, weight:1.8, topic:'world' },
];
const balanced = selectStories(allFinance, { count: 3, now });
ok('markets cannot take every slot, even across three topics',
  balanced.filter(c => ['crypto','markets-india','markets-world'].includes(c.lead.topic)).length <= 2,
  balanced.map(c => c.lead.topic).join(','));
ok('a general story gets in even with less corroboration',
  balanced.some(c => c.lead.topic === 'world'),
  balanced.map(c => c.lead.topic).join(','));

// On a quiet day the cap must not leave the post short.
const onlyCrypto = lopsided.slice(0, 3);
ok('the cap still fills the post when there is nothing else',
  selectStories(onlyCrypto, { count: 3, now }).length === 3,
  `${selectStories(onlyCrypto, { count: 3, now }).length} picked`);
ok('a markets-only day still produces a full post',
  selectStories(allFinance.filter(i => i.topic !== 'world'), { count: 3, now }).length === 3);

/* ── Headlines ────────────────────────────────────────────────── */

ok('drops the trailing outlet name',
  tidy('Bitcoin tops $90,000 - Reuters') === 'Bitcoin tops $90,000');
ok('drops a BREAKING prefix',
  tidy('BREAKING: Fed cuts rates') === 'Fed cuts rates');

const long = makeHeadline('Federal Reserve cuts interest rates by 25 basis points, citing cooling inflation and a weakening labour market across most sectors');
ok('a long headline is shortened', long.headline.length <= 90, `${long.headline.length} chars`);
ok('shortening does not cut mid-word', !/\s\S{1,2}$/.test(long.headline), long.headline);

const short = makeHeadline('Bitcoin up');
ok('a fragment is flagged unusable', short.usable === false);

/* A card went out reading "Stock market holiday tomorrow on Dussehra: Are BSE"
   — the cut landed inside the question, and the shortlist reported it as
   untouched. */
const dussehra = makeHeadline('Stock market holiday tomorrow on Dussehra: Are BSE, NSE open or '
  + 'closed for trading on Tuesday 20 Oct? Check calendar');
ok('a colon is preferred to a comma inside a list',
  dussehra.display === 'Stock market holiday tomorrow on Dussehra', dussehra.display);
ok('shortening at a clause is reported as shortened', dussehra.truncated === true);
ok('an untouched headline is not reported as shortened',
  makeHeadline('Ceasefire talks resume in Geneva').truncated === false);
ok('a headline never ends on a dangling word', (() => {
  const cases = [
    'Government to announce a new policy on digital payments and the rules that will apply to it',
    'Officials say the inquiry will look into the conduct of several senior managers and others',
    'Regulator opens a review of listing rules, of fees, and of the disclosure regime in general',
  ];
  return cases.every(c => !/\b(to|and|of|the|a|an|in|on|for|by|with|is|are)$/i
    .test(makeHeadline(c).display));
})());

const cased = makeHeadline('SEC approves spot Solana ETF applications');
ok('display keeps the outlet\'s capitalisation',
  cased.display === 'SEC approves spot Solana ETF applications', cased.display);
ok('headline is upper case for the Breaking layout',
  cased.headline === cased.headline.toUpperCase());

ok('a headline only ever loses words, never gains them', (() => {
  const src = 'Fed cuts rates by 25 basis points';
  const outWords = makeHeadline(src).display.toLowerCase().split(/\s+/);
  const srcWords = new Set(src.toLowerCase().split(/\s+/));
  return outWords.every(w => srcWords.has(w));
})());

/* ── Corroboration has to be an honest number ─────────────────── */
/* These are real source lists from live runs. The count on the card is the
   reader's only reason to believe a headline from an account that does no
   reporting of its own, and it was being inflated three different ways. */

ok('a spelling variant is not a second outlet',
  canonicalSource('The Times of India') === canonicalSource('Times of India')
  && canonicalSource('BBC News') === canonicalSource('BBC')
  && canonicalSource('Moneycontrol.com') === canonicalSource('Moneycontrol'));
ok('two mastheads of one newsroom are one source',
  canonicalSource('Mint') === canonicalSource('Livemint')
  && canonicalSource('Economic Times') === canonicalSource('Times of India')
  && canonicalSource('News On AIR') === canonicalSource('DD India'));
ok('genuinely different outlets stay different',
  new Set(['CoinDesk','Cointelegraph','Reuters','The Hindu','NDTV'].map(canonicalSource)).size === 5);
ok('a republisher is recognised',
  isRepublisher('Yahoo Finance') && isRepublisher('MSN') && isRepublisher('Sarkaritel.com')
  && !isRepublisher('Reuters') && !isRepublisher('The Hindu'));

ok('["BBC News","BBC"] is ONE source, not two',
  independentSources(['BBC News', 'BBC']).count === 1);
ok('["Times of India","Sarkaritel.com","The Times of India"] is ONE source',
  independentSources(['Times of India', 'Sarkaritel.com', 'The Times of India']).count === 1,
  JSON.stringify(independentSources(['Times of India','Sarkaritel.com','The Times of India'])));
ok('a six-name list of three newsrooms counts three',
  independentSources(['Economic Times','Mint','Moneycontrol.com','Livemint',
                      'Yahoo Finance','Univest']).count === 3);
ok('republishers are still named, just not counted', (() => {
  const r = independentSources(['Times of India', 'Yahoo Finance']);
  return r.count === 1 && r.republishers.includes('Yahoo Finance');
})());
ok('the attribution line carries one name per newsroom',
  independentSources(['Economic Times','The Times of India','NDTV','Deccan Herald',
                      'Times of India']).names.length === 3);
ok('an honest count is what reaches the card', (() => {
  const items = [
    { title: 'Rupee steadies against the dollar', source: 'Times of India', published: Date.now(), topic: 'markets-india' },
    { title: 'Rupee steadies against the dollar today', source: 'The Times of India', published: Date.now(), topic: 'markets-india' },
    { title: 'Rupee steadies against the dollar in trade', source: 'Yahoo Finance', published: Date.now(), topic: 'markets-india' },
  ];
  const [chosen] = selectStories(items, { count: 1 });
  return chosen && chosen.sources === 1;
})());

/* ── The breaking bar ─────────────────────────────────────────── */
/* A watch that runs every fifteen minutes has to find nothing almost every
   time, or it becomes a machine for manufacturing urgency. */

const breakingItems = (hoursOld, sources) => sources.map((s, i) => ({
  title: 'Central bank governor resigns without notice',
  source: s, published: Date.now() - hoursOld * 3600000, topic: 'world', weight: 1,
}));

ok('three independent newsrooms within the hour clears the bar',
  selectStories(breakingItems(0.5, ['Reuters', 'BBC News', 'The Hindu']),
                { count: 1, minSources: 3, maxAgeHours: 2 }).length === 1);
ok('two newsrooms does not clear it',
  selectStories(breakingItems(0.5, ['Reuters', 'BBC News']),
                { count: 1, minSources: 3, maxAgeHours: 2 }).length === 0);
ok('three names for two newsrooms does not clear it',
  selectStories(breakingItems(0.5, ['Times of India', 'The Times of India', 'NDTV']),
                { count: 1, minSources: 3, maxAgeHours: 2 }).length === 0,
  'spelling variants must not pass the breaking bar');
ok('a story with republishers padding it does not clear it',
  selectStories(breakingItems(0.5, ['Reuters', 'Yahoo Finance', 'MSN']),
                { count: 1, minSources: 3, maxAgeHours: 2 }).length === 0);
ok('an old story does not clear it however well corroborated',
  selectStories(breakingItems(9, ['Reuters', 'BBC News', 'The Hindu', 'NDTV']),
                { count: 1, minSources: 3, maxAgeHours: 2 }).length === 0);
ok('a story already offered for approval does not come back',
  selectStories(breakingItems(0.5, ['Reuters', 'BBC News', 'The Hindu']),
                { count: 1, minSources: 3, maxAgeHours: 2,
                  history: [{ title: 'Central bank governor resigns without notice' }] }).length === 0);

/* ── Not news, found by widening to five sections ─────────────── */
/* Top stories is three slots with heavy competition. Sections are a dozen
   more, and the first live sectioned run filled them with a podcast running
   order and two vendor press releases. */

ok('a podcast running order is not a story',
  isJunk('PODCAST: Ukraine intelligence sharing, France reels and Alberta’s vote')
  && isJunk('WATCH: Protesters gather outside parliament'));
ok('a product launch notice is a press release, not news',
  isPressRelease('Introducing Bulbul V4 Flash text-to-speech for India')
  && isPressRelease('Siemens partners with NVIDIA to advance AI-driven factories')
  && isPressRelease('Announcing the general availability of our new platform'));
ok('real corporate news is not mistaken for marketing',
  !isJunk('Microsoft exits UK’s largest AI data centre project over power supply')
  && !isJunk('Reliance partners with Google to build data centres in Gujarat')
  && !isJunk('Apple launches iPhone 18 with satellite messaging'),
  'a company doing something newsworthy is still news');

ok('a section will not carry a single-outlet story', (() => {
  const now = Date.now();
  const mk = (title, source, topic) => ({ title, source, topic, published: now - 600000, weight: 1 });
  const items = [
    mk('Alpha reshuffles its cabinet', 'NDTV', 'india'),
    mk('Alpha reshuffles cabinet in surprise move', 'The Hindu', 'india'),
    mk('Beta signs a quiet memorandum', 'OnlyOutlet', 'india'),   // one newsroom
  ];
  const secs = selectSections(items, { count: 1, perSection: 5 });
  const india = secs.find(s => s.id === 'india');
  return !india || india.clusters.every(c => c.sources >= 2);
})(), 'nobody scrutinises fifteen headlines every morning');

/* ── Sorting the day into sections ────────────────────────────── */

/* Every story here is carried by two independent newsrooms, because that is
   now the bar for a section. A fixture of single-outlet pieces would test the
   sorting against material the real pipeline would never offer. */
const sectionItems = () => {
  const now = Date.now();
  const mk = (title, source, topic) => ({ title, source, topic, published: now - 600000, weight: 1 });
  const pair = (a, b, topic, s1, s2) => [mk(a, s1, topic), mk(b, s2, topic)];
  return [
    ...pair('Prime minister announces new housing scheme',
            'Prime minister announces housing scheme for cities', 'india', 'NDTV', 'The Hindu'),
    ...pair('Heavy rain shuts schools across Kerala',
            'Heavy rain closes schools across Kerala', 'india', 'NDTV', 'Deccan Herald'),
    ...pair('Summit ends without agreement on emissions',
            'Emissions summit ends with no agreement', 'world', 'BBC News', 'Reuters'),
    ...pair('Border talks adjourned for a second week',
            'Border talks adjourned again for a second week', 'world', 'Al Jazeera', 'Reuters'),
    ...pair('Sensex climbs 540 points to a record high',
            'Sensex climbs 540 points to record high', 'markets-india', 'Economic Times', 'NDTV'),
    ...pair('Bitcoin holds above $90,000',
            'Bitcoin holds above $90,000 in quiet trade', 'crypto', 'CoinDesk', 'Cointelegraph'),
    ...pair('Chipmaker ships a smaller process node',
            'Chipmaker starts shipping a smaller process node', 'tech', 'Reuters', 'The Hindu'),
    ...pair('Regulator opens a review of app store fees',
            'Regulator reviews app store fees', 'tech', 'BBC News', 'Reuters'),
  ];
};

ok('the day comes back sorted into sections', (() => {
  const secs = selectSections(sectionItems(), { count: 3, perSection: 3 });
  const known = new Set(SECTIONS.map(s => s.id));
  // Which sections survive depends on what Top took first, so assert the
  // contract rather than a particular morning: Top leads, the ids are real,
  // and every story sits in the section it belongs to.
  return secs[0].id === 'top'
    && secs.length >= 3
    && secs.every(s => known.has(s.id))
    && secs.filter(s => s.id !== 'top')
           .every(s => s.clusters.every(c => sectionOf(c.lead.topic) === s.id));
})(), JSON.stringify(selectSections(sectionItems(), { count: 3 }).map(s => s.id)));

ok('top stories come first, so output[0] is still the top post',
  selectSections(sectionItems(), { count: 3 })[0].label === 'TOP STORIES');

ok('every market topic lands in Business', (() => {
  const secs = selectSections(sectionItems(), { count: 1, perSection: 5 });
  const biz = secs.find(s => s.id === 'business');
  return biz && biz.clusters.every(c =>
    ['markets-india','markets-world','crypto','business'].includes(c.lead.topic));
})());

ok('a story in Top does not appear again in its section', (() => {
  const secs = selectSections(sectionItems(), { count: 3, perSection: 5 });
  const top = secs.find(s => s.id === 'top').clusters.map(c => c.lead.title);
  const rest = secs.filter(s => s.id !== 'top').flatMap(s => s.clusters.map(c => c.lead.title));
  return top.every(t => !rest.includes(t));
})(), 'no story may be posted twice in one morning');

ok('an empty section is not offered as a post', (() => {
  const secs = selectSections(sectionItems(), { count: 3, perSection: 3 });
  return secs.every(s => s.id === 'top' || s.clusters.length > 0);
})());

ok('sections respect the no-repeats history', (() => {
  const secs = selectSections(sectionItems(), {
    count: 1, perSection: 5,
    history: [{ title: 'Heavy rain shuts schools across Kerala' }],
  });
  return secs.filter(s => s.id !== 'top')
    .flatMap(s => s.clusters.map(c => c.lead.title))
    .every(t => !/Heavy rain/.test(t));
})());

ok('a topic with no section of its own is still reachable',
  sectionOf('india') === 'india' && sectionOf('crypto') === 'business'
  && sectionOf('something-new') === 'top');

ok('sources are named', sourceLine(['CoinDesk', 'Reuters']) === 'CoinDesk · Reuters');
ok('the headline overrides the feed when it plainly disagrees',
  categoryFor('markets-world', 'NSE, BSE to remain closed tomorrow') === 'INDIA MARKETS'
  && categoryFor('world', 'Bitcoin tops $90,000') === 'CRYPTO NEWS',
  categoryFor('markets-world', 'NSE, BSE to remain closed tomorrow'));
ok('an ordinary world story keeps its feed category',
  categoryFor('world', 'Ceasefire talks resume in Geneva') === 'WORLD NEWS');

ok('category comes from the topic',
  categoryFor('markets-india') === 'INDIA MARKETS'
  && categoryFor('india') === 'INDIA'
  && categoryFor('world') === 'WORLD NEWS'
  && categoryFor('tech') === 'TECHNOLOGY');

/* ── Some stories are better illustrated by the chart ─────────── */

ok('an index move prefers the chart',
  prefersChart('Sensex tumbles 876 points; Nifty drops below 22,900')
  && prefersChart('Dow closes 500 points lower'));
ok('a market holiday does not — a photo suits it',
  !prefersChart('Stock market holiday tomorrow on Dussehra: Are BSE, NSE closed?'));
ok('ordinary news still wants a photo',
  !prefersChart('Ceasefire talks resume in Geneva')
  && !prefersChart('JPMorgan expands JPM Coin deposit token to Ethereum'));
ok('the chart preference short-circuits the search', (() => {
  let called = false;
  const spy = async () => { called = true; return { ok:true, json: async () => ({ results: [] }) }; };
  return findImage('Sensex tumbles 876 points', { fetchImpl: spy })
    .then(r => r.image === null && !called);
})());

ok('an outlet byline is stripped',
  tidy('Why is SES stock gaining today? By Investing.com') === 'Why is SES stock gaining today?',
  tidy('Why is SES stock gaining today? By Investing.com'));
ok('an ordinary "by" is left alone',
  tidy('Report by committee finds no wrongdoing') === 'Report by committee finds no wrongdoing');
ok('an explainer about a price move is refused',
  isAdvice('Why is SES stock gaining today?'));

/* ── Imagery: only what may legally be reused ─────────────────── */

const img = (o) => ({ url:'https://x/i.jpg', width:2000, height:1300, creator:'A Person',
                      license:'cc0', ...o });

ok('CC0 is usable', isUsable(img({ license:'cc0' })));
ok('public domain is usable', isUsable(img({ license:'pdm' })));
ok('CC-BY is usable, with credit', isUsable(img({ license:'by' })));
ok('share-alike is REFUSED', !isUsable(img({ license:'by-sa' })), 'by-sa');
ok('non-commercial is REFUSED', !isUsable(img({ license:'by-nc' })), 'by-nc');
ok('no-derivatives is REFUSED', !isUsable(img({ license:'by-nd' })), 'by-nd');
ok('an unknown licence is REFUSED', !isUsable(img({ license:'all-rights-reserved' })));
ok('a missing licence is REFUSED', !isUsable(img({ license:undefined })));
ok('a tiny image is refused', !isUsable(img({ width:600, height:400 })));
ok('a tall portrait is refused', !isUsable(img({ width:1200, height:2000 })));

ok('the least restrictive licence wins',
  pickBest([img({license:'by', width:4000}), img({license:'cc0', width:1600})]).license === 'cc0');
ok('nothing usable returns nothing',
  pickBest([img({license:'by-nc'}), img({license:'by-nd'})]) === null);
ok('an empty result is handled', pickBest([]) === null && pickBest(undefined) === null);

ok('CC-BY credit names the creator and licence',
  creditFor({ creator:'Jane Doe', license:'by', license_version:'4.0' })
    === 'File photo: Jane Doe / CC BY 4.0',
  creditFor({ creator:'Jane Doe', license:'by', license_version:'4.0' }));
ok('CC0 credit still names the creator',
  creditFor({ creator:'Jane Doe', license:'cc0' }) === 'File photo: Jane Doe / CC0');
/* A library photograph of an identifiable person ran under a Gaza headline.
   Nothing here is a picture of what was reported, and the card has to say so. */
ok('every credit says the picture is a file photo',
  ['cc0','pdm','by'].every(l => /^File photo: /.test(creditFor({ creator:'A', license:l }))));
ok('a missing creator does not produce "undefined"',
  !/undefined/.test(creditFor({ license:'cc0' })), creditFor({ license:'cc0' }));

ok('a named institution drives the search',
  subjectFor('Federal Reserve cuts interest rates') === 'federal reserve building',
  subjectFor('Federal Reserve cuts interest rates'));
ok('Sensex maps to an Indian subject',
  /mumbai/.test(subjectFor('Sensex climbs 540 points to a record high')));
ok('there is always a subject',
  subjectFor('Something entirely unexpected happens').length > 0);

/* The last-resort query has to follow the beat. A conference in Delhi was
   falling back to "stock market trading screen" — a picture of a different
   story, not a weaker picture of this one. */
ok('the fallback follows the topic, not finance',
  subjectFor('Something entirely unexpected happens', 'india') === 'india'
  && subjectFor('Something entirely unexpected happens', 'world') === 'international summit flags'
  && subjectFor('Something entirely unexpected happens', 'tech') === 'technology data centre');
ok('a markets topic still falls back to a markets picture',
  /market/.test(subjectFor('Something unexpected happens', 'markets-world')));
ok('an unknown topic falls back to something neutral',
  subjectFor('Something unexpected happens', 'nonsense') === 'newspapers',
  subjectFor('Something unexpected happens', 'nonsense'));
ok('one substantial opening word is enough of a subject',
  queriesFor('India To Host Global Legal Metrology Meet For First Time', 'india')[0] === 'India',
  JSON.stringify(queriesFor('India To Host Global Legal Metrology Meet For First Time', 'india')));

/* "Stock Market Holiday On 20 Oct: NSE, BSE Closed For Dussehra?" was searched
   as "Stock Market Holiday" and came back with a Taiwanese fish shop. */
ok('generic nouns a title case headline capitalises are not subjects',
  queriesFor('Stock Market Holiday On 20 Oct: NSE, BSE Closed For Dussehra?', 'markets-india')[0]
    === 'Dussehra',
  JSON.stringify(queriesFor('Stock Market Holiday On 20 Oct: NSE, BSE Closed For Dussehra?',
                            'markets-india')));
ok('a date is never the subject',
  !queriesFor('India-New Zealand FTA Effective From Oct 20; Targets Double Trade', 'india')
    .some(q => /^(Oct|Monday|January)$/.test(q)),
  JSON.stringify(queriesFor('India-New Zealand FTA Effective From Oct 20; Targets Double Trade',
                            'india')));
/* "Neha Bora moves Delhi High Court against peace bond notice" was searched by
   her name. A photograph of a stranger who shares it, under that headline,
   says that stranger is the subject of a legal proceeding. */
ok('a legal matter is never searched by the name in it',
  queriesFor('Neha Bora moves Delhi High Court against peace bond notice', 'india')
    .every(q => !/Neha|Bora/.test(q)),
  JSON.stringify(queriesFor('Neha Bora moves Delhi High Court against peace bond notice', 'india')));
ok('a legal matter gets a generic subject instead',
  queriesFor('Neha Bora moves Delhi High Court against peace bond notice', 'india')
    .length === 1);
ok('ordinary stories still get their named subject',
  queriesFor('Deutsche Bank Is Weeks From Holding Bitcoin for Clients', 'crypto')[0]
    === 'Deutsche Bank');

ok('a match made only of generic words is no match', (() => {
  const hl = 'Stock Market Holiday On 20 Oct: NSE, BSE Closed For Dussehra?';
  const fish = { title: 'Fish market on a holiday', tags: [{name:'market'},{name:'fish'}] };
  const real = { title: 'Dussehra effigy burning', tags: [{name:'dussehra'}] };
  return relevance(fish, hl) === 0 && relevance(real, hl) > 0.2;
})());

/* ── What goes behind a card with no photograph ───────────────── */
/* The chart used to go behind everything, which made a claim the story did
   not: a card about a legal-metrology conference went out over a falling
   price line, which reads as "this is a markets story". */

ok('a markets story gets the chart',
  backdropFor('Sensex tumbles 876 points; Nifty drops below 22,900', 'markets-world') === 'chart'
  && backdropFor('Reliance Q2 profit rises 12% on retail strength', 'business') === 'chart'
  && backdropFor('JPMorgan expands JPM Coin deposit token to Ethereum', 'crypto') === 'chart');
ok('a general-news story does NOT get the chart',
  backdropFor('India To Host Global Legal Metrology Meet For First Time', 'india') === 'editorial',
  backdropFor('India To Host Global Legal Metrology Meet For First Time', 'india'));
ok('world, India and tech stories do not get the chart',
  backdropFor('Ceasefire talks resume in Geneva', 'world') === 'editorial'
  && backdropFor('Heavy rain shuts schools across Kerala', 'india') === 'editorial'
  && backdropFor('New AI model released by startup', 'tech') === 'editorial');
/* A sum of money is not market data. A trade agreement "targeting $7bn by
   2030" went out over a price chart, which is a different kind of story. */
ok('a sum of money alone does not earn the chart',
  backdropFor('India-New Zealand FTA effective from Oct 20; targets double trade to $7bn by 2030',
              'india') === 'editorial'
  && backdropFor('Government approves ₹12,000 crore package', 'india') === 'editorial');
ok('the markets beat earns the chart even without market words',
  backdropFor('Regulator names new chief', 'markets-india') === 'chart');

/* ── No stock photograph on a story about people in harm ──────── */
/* An aid photograph of an identifiable woman ran under a headline about
   cutting aid to Gaza; she was photographed somewhere else entirely. */

ok('a war or humanitarian story is treated as sensitive',
  isSensitive('Funding shortages force World Food Programme to cut aid to Gaza')
  && isSensitive('Air strikes kill at least 12 in northern province')
  && isSensitive('Earthquake survivors still without shelter'));
ok('ordinary news is not treated as sensitive',
  !isSensitive('India To Host Global Legal Metrology Meet For First Time')
  && !isSensitive('Sensex climbs 540 points to a record high')
  && !isSensitive('Researchers release an open model that runs on a laptop'));
ok('a sensitive story never reaches the image search', (() => {
  let called = false;
  const spy = async () => { called = true; return { ok:true, json: async () => ({ results: [] }) }; };
  return findImage('Funding shortages force World Food Programme to cut aid to Gaza',
                   { fetchImpl: spy, topic: 'world' })
    .then(r => r.image === null && !called && /misrepresent/.test(r.error));
})());
ok('and it falls back to the editorial backdrop, not the chart',
  backdropFor('Funding shortages force World Food Programme to cut aid to Gaza', 'world')
    === 'editorial');

/* The picture should be of the story, not of its genre. */

ok('a person in the headline becomes the subject',
  queriesFor("Michael Saylor highlights Bitcoin's expanding role")[0] === 'Michael Saylor',
  queriesFor("Michael Saylor highlights Bitcoin's expanding role")[0]);
ok('a company in the headline becomes the subject',
  queriesFor('ICICI Bank Q2 Results: Net profit jumps 20% YoY')[0] === 'ICICI Bank',
  queriesFor('ICICI Bank Q2 Results: Net profit jumps 20% YoY')[0]);
ok('an institution is found mid-sentence',
  queriesFor('Federal Reserve cuts interest rates by 25 basis points')[0] === 'Federal Reserve');
ok('a Title Case Headline still yields its subject',
  queriesFor('Deutsche Bank Is Weeks From Holding Bitcoin for Clients')[0] === 'Deutsche Bank',
  queriesFor('Deutsche Bank Is Weeks From Holding Bitcoin for Clients')[0]);
ok('the category is kept as a last resort',
  queriesFor('Oil prices slip on demand concerns').slice(-1)[0] === 'oil refinery');
ok('reporting words are not mistaken for subjects',
  !queriesFor('Net profit jumps as revenue climbs').some(q => /Net|Profit|Revenue/.test(q)),
  JSON.stringify(queriesFor('Net profit jumps as revenue climbs')));
ok('a title-case headline is recognised',
  isTitleCase('Deutsche Bank Is Weeks From Holding Bitcoin for Clients')
  && !isTitleCase('Oil prices slip on demand concerns'));

ok('a result echoing the headline scores higher', (() => {
  const h = 'ICICI Bank Q2 results beat estimates';
  const match = { title: 'ICICI Bank headquarters Mumbai', tags: [{name:'bank'}] };
  const generic = { title: 'A sunset over water', tags: [{name:'sunset'}] };
  return relevance(match, h) > relevance(generic, h);
})());
ok('relevance copes with no title or tags', relevance({}, 'Anything at all') === 0);

// Specific query matches -> it wins; nothing matches -> falls back down the list.
const specific = async (url) => ({ ok:true, json: async () => ({ results:
  /Saylor/.test(decodeURIComponent(url))
    ? [img({ title:'Michael Saylor speaking', url:'https://x/saylor.jpg' })]
    : [img({ title:'A gold coin', url:'https://x/coin.jpg' })] }) });
const matched = await findImage('Michael Saylor highlights Bitcoin treasuries',
  { fetchImpl: specific });
ok('the specific subject wins when it matches',
  matched.image?.url === 'https://x/saylor.jpg' && matched.query === 'Michael Saylor',
  `${matched.query} -> ${matched.image?.url}`);

const noMatch = async () => ({ ok:true, json: async () => ({ results:
  [img({ title:'A red car in a forest', tags:[{name:'car'}], url:'https://x/car.jpg' })] }) });
const fell = await findImage('Michael Saylor highlights Bitcoin treasuries', { fetchImpl: noMatch });
ok('a picture of nothing to do with the story is refused',
  fell.image === null && /closely enough/.test(fell.error || ''), JSON.stringify(fell.error));

const looseMatch = async () => ({ ok:true, json: async () => ({ results:
  [img({ title:'Bitcoin mining rigs', tags:[{name:'bitcoin'}], url:'https://x/rigs.jpg' })] }) });
ok('a loosely related picture is still used',
  (await findImage('Michael Saylor highlights Bitcoin treasuries',
    { fetchImpl: looseMatch })).image?.url === 'https://x/rigs.jpg');

// The search itself, with the API stubbed.
const stubOk = async () => ({ ok:true, json: async () => ({ results: [
  img({ license:'by-nc', creator:'No',  title:'Bitcoin rallies hard' }),   // skipped: licence
  img({ license:'by',    creator:'Yes', title:'Bitcoin rallies hard', width:3000 }),
]}) });
const found = await findImage('Bitcoin rallies', { fetchImpl: stubOk });
ok('the search skips unusable licences', found.image?.credit.includes('Yes'), JSON.stringify(found.image));

const stubEmpty = async () => ({ ok:true, json: async () => ({ results: [img({license:'by-nd'})] }) });
ok('nothing usable yields no image, not a bad one',
  (await findImage('x', { fetchImpl: stubEmpty })).image === null);

// The same subject twice must not yield the same photograph twice.
const two = [img({license:'cc0', url:'https://x/a.jpg', width:3000, title:'Bitcoin again'}),
             img({license:'cc0', url:'https://x/b.jpg', width:2000, title:'Bitcoin again'})];
ok('an already-used image is skipped',
  pickBest(two, new Set(['https://x/a.jpg'])).url === 'https://x/b.jpg');
ok('everything used means no image, not a repeat',
  pickBest(two, new Set(['https://x/a.jpg','https://x/b.jpg'])) === null);
const stubTwo = async () => ({ ok:true, json: async () => ({ results: two }) });
const second = await findImage('Bitcoin again',
  { fetchImpl: stubTwo, exclude: new Set(['https://x/a.jpg']) });
ok('the search honours the exclusion list', second.image?.url === 'https://x/b.jpg',
  second.image?.url || second.error);

const stubDown = async () => { throw new Error('network is down'); };
const downed = await findImage('x', { fetchImpl: stubDown });
ok('a failed search is not fatal', downed.image === null && /network/.test(downed.error), downed.error);

/* ── Caption ──────────────────────────────────────────────────── */

for (const kind of ['digest', 'carousel']) {
const caption = buildCaption({
  kind,
  stories: [
    { display: 'Fed cuts rates by 25 basis points', topic: 'world', source: 'Reuters' },
    { display: 'SEC approves Solana ETF', topic: 'crypto', source: 'CoinDesk' },
  ],
  sourceNames: ['Reuters', 'CoinDesk'],
});
ok(`${kind} caption carries the headlines`, caption.includes('Fed cuts rates by 25 basis points'));
ok(`${kind} caption names the sources`, /Reuters/.test(caption) && /CoinDesk/.test(caption));
ok(`${kind} caption fits Instagram`, caption.length <= 2200, `${caption.length} chars`);
ok(`${kind} caption is not a bare count`, !/^\d+ stories/.test(caption.trim()), caption.slice(0,24));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
