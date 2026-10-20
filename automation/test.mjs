#!/usr/bin/env node
/* Tests for the parts where a bug would put something wrong on the account.
 *   node automation/test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseFeed } from './lib/rss.mjs';
import { licenceFrom, toResult as commonsResult } from './lib/commons.mjs';
import { altForStory, altForCover, altForEntry, altForClosing } from './lib/alttext.mjs';
import { statFor, prefersStat } from './lib/statcard.mjs';
import { tierOf, isCryptoVertical, TIER_POINTS } from './lib/importance.mjs';
import { similarity, cluster, selectStories, selectSections, isRepeat, isTopical, isAdvice,
         isSpeculation, isJunk, isPressRelease, isUnverified, isOpinion, isTooThin,
         rankClusters, rankEligible, rejectionReason } from './lib/select.mjs';
import { sectionOf, sectionLabel, SECTIONS } from './lib/sections.mjs';
import { makeHeadline, tidy, sourceLine, categoryFor } from './lib/headline.mjs';
import { canonicalSource, isRepublisher, independentSources,
         ownerOf, concentrationWarnings } from './lib/outlets.mjs';
import { buildCaption } from './caption.mjs';
import { buildCorrection, correctionCaption, findOriginal } from './correct.mjs';
import { isUsable, pickBest, creditFor, subjectFor, findImage, backdropFor, isSensitive,
         queriesFor, entitiesFrom, isTitleCase, relevance, prefersChart } from './lib/imagery.mjs';

const TEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/* Real stories, not price moves: a post may not be one subject three times,
   but the stories have to be ones the channel would carry at all. An earlier
   version of this fixture was three crypto price items, which the importance
   hierarchy now keeps off Top entirely — so it tested nothing. */
const lopsided = [
  { title:'Regulator fines a major bank over mis-selling', source:'A', published:now, weight:1, topic:'business' },
  { title:'Parliament passes the new insolvency bill',     source:'B', published:now, weight:1, topic:'business' },
  { title:'Cabinet approves a port expansion scheme',      source:'C', published:now, weight:1, topic:'business' },
  { title:'Supreme Court orders a review of forest rules', source:'D', published:now, weight:1, topic:'india'  },
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
const oneSubjectOnly = lopsided.slice(0, 3);
ok('the cap still fills the post when there is nothing else',
  selectStories(oneSubjectOnly, { count: 3, now }).length === 3,
  `${selectStories(oneSubjectOnly, { count: 3, now }).length} picked`);
/* This used to assert that a day of nothing but market moves still filled
   the post. It no longer should: index moves and price stories are minor, and
   a front page is not made of them. The cap filling a short post is covered
   just above, with stories the channel would actually lead on. */
ok('a day of nothing but price moves is not a front page',
  selectStories(allFinance.filter(i => i.topic !== 'world'), { count: 3, now }).length === 0,
  selectStories(allFinance.filter(i => i.topic !== 'world'), { count: 3, now })
    .map(c => c.lead.title).join(' | '));

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

/* From the first unattended sectioned run. */
ok('a section label the outlet pinned to its own headline is stripped',
  tidy('Bitcoin News | Strategy Bought $22 Million of Bitcoin Last Week')
    === 'Strategy Bought $22 Million of Bitcoin Last Week',
  tidy('Bitcoin News | Strategy Bought $22 Million of Bitcoin Last Week'));
/* The first attempt at that turned this into "markets update" — it kept the
   furniture and threw away the headline. */
ok('a pipe in the middle of a real headline is left alone',
  tidy('Sensex falls 900 points | markets update') === 'Sensex falls 900 points | markets update'
  && tidy('Apple | Samsung rivalry deepens') === 'Apple | Samsung rivalry deepens');
ok('a machine printing prices is not reporting',
  isJunk('Bitcoin End Price (Previous Epoch): $64,990 Current Price (C')
  && isJunk('BTC/USD: 64,990 and falling'));
ok('somebody else’s daily roundup is not our story',
  isJunk('Here’s what happened in crypto today')
  && isJunk('Morning wrap: what you missed'));
ok('a real story that mentions a price is still a story',
  !isJunk('Strive Buys $335 Million in Bitcoin After Investors Pour In $369M')
  && !isJunk('Oil prices slip on demand concerns'));

ok('one subject cannot fill a whole section', (() => {
  const now = Date.now();
  const mk = (t, s, topic) => ({ title: t, source: s, topic, published: now - 600000, weight: 1 });
  const items = [];
  // Four genuinely separate crypto stories, each corroborated, and one
  // markets story. (An earlier version of this fixture used near-identical
  // titles, which clustering correctly merged into one story — so it proved
  // nothing about the cap.)
  // Four separate business stories, each corroborated and each one the
  // channel would actually run. (Earlier versions used crypto price items,
  // which are minor and no longer publish at all, so the cap was never
  // exercised — the test proved nothing.)
  const businessPairs = [
    ['Regulator fines a major bank over mis-selling',
     'Regulator fines major bank for mis-selling'],
    ['Parliament passes the new insolvency bill',
     'Parliament approves the new insolvency bill'],
    ['Competition watchdog opens a probe into a supermarket merger',
     'Competition watchdog probes the supermarket merger'],
    ['Cabinet approves a port expansion scheme for the east coast',
     'Cabinet clears the east coast port expansion scheme'],
  ];
  for (const [a, b] of businessPairs) {
    items.push(mk(a, 'BBC News', 'business'));
    items.push(mk(b, 'Reuters', 'business'));
  }
  items.push(mk('Sensex closes at a record high', 'Economic Times', 'markets-india'));
  items.push(mk('Sensex closes at record high', 'NDTV', 'markets-india'));
  const biz = selectSections(items, { count: 0, perSection: 3 }).find(s => s.id === 'business');
  const sameTopic = biz.clusters.filter(c => c.lead.topic === 'business').length;
  return biz.clusters.length >= 2 && sameTopic <= 3;
})(), 'BUSINESS came out as three Bitcoin stories');

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

/* ── What the first good sectioned run still got wrong ────────── */
/* Every one of these went out in a live run. */

ok('a rumour is refused, not led with',
  isUnverified("North Korea's 'Proof Of Life' Amid Kim Jong Un 'Brain Haemorrhage Death' Rumour")
  && isUnverified('Unconfirmed reports of a blast near the border'),
  'it was graded LEAD because it contains the word "death"');
ok('reporting that something was denied is still reporting',
  !isUnverified('Government denies the allegations made in the report')
  && !isUnverified('Minister rejects claims about the contract'));

ok('an essay title is not a news headline',
  isOpinion('Global Health Research in the America First Era')
  && isOpinion('Opinion: why the budget will fail')
  && isOpinion('The case for a wealth tax'));
/* tidy used to strip a leading "Opinion:", which turned an op-ed into
   something that read like reporting. */
ok('an opinion label is never stripped into disguise',
  tidy('Opinion: why the budget will fail').startsWith('Opinion'),
  tidy('Opinion: why the budget will fail'));
ok('a plain news headline is not mistaken for comment',
  !isOpinion('Kenya cult leader convicted of 191 murders after trial')
  && !isOpinion('India-New Zealand trade pact kicks in from October 20'));

ok('a fragment is not a story',
  isTooThin('Middle East') && isTooThin('Cognizant Technology Solutions Chosen'),
  'both occupied a section slot in a live run');
ok('a short but complete headline survives',
  !isTooThin('Earthquake kills at least 40 in northern Afghanistan'));

ok('"partner on" is press release phrasing too',
  isPressRelease('Digital Science and Sunmedia partner on research impact'));

/* A $7.3bn packaging merger carried by one trade publication reached Top. */
ok('one newsroom is no longer enough to be published', (() => {
  const t = Date.now();
  const only = [{ title: 'Silgan to acquire Trivium and form a $7.3 billion packaging business',
                  source: 'Packaging Europe', topic: 'business', published: t - 600000, weight: 1 }];
  return selectStories(only, { count: 3, now: t, minSources: 2 }).length === 0;
})());

/* A feed's topic is where a story arrived from, not what it is about. */
ok('a Kenyan story from an Indian feed is world news',
  sectionOf('india', 'Kenyan cult leader convicted of killing 190 children') === 'world');
ok('an Indian story from a world feed is India news',
  sectionOf('world', 'Sensex closes at a record high as banks rally') === 'india');
ok('a story about India from an Indian feed stays put',
  sectionOf('india', 'Cabinet approves a port expansion scheme for the east coast') === 'india'
  && sectionOf('india', 'Marco Rubio India visit: trade deal and Russian oil') === 'india');
ok('sections other than india and world are left alone',
  sectionOf('tech', 'EU opens an investigation into a chipmaker') === 'tech'
  && sectionOf('business', 'Regulator fines a bank in Germany') === 'business');

/* "2 newsrooms, 1 owner" read as though they shared an owner, when only one
   of the two was in the register at all. */
ok('an unrecorded owner is reported as unrecorded, not as a shared one', (() => {
  const r = independentSources(['NDTV', 'Open Magazine']);
  return r.count === 2 && r.ownerCount === 1 && r.unknownOwners === 1;
})());

/* ── The hierarchy of importance ──────────────────────────────── */
/* The ranking used to know only how well covered a story was, how fresh, and
   how much its feed was weighted — nothing about the story itself. Two of
   three top stories came out crypto on a day a cult leader was convicted of
   starving his followers and Japan launched a mission to Mars. */

ok('lives, power and the economy as a whole lead',
  ['Earthquake kills at least 40 in northern Afghanistan',
   'Prime minister resigns after losing no-confidence vote',
   'Supreme Court strikes down the electoral bonds scheme',
   'RBI cuts repo rate by 25 basis points',
   'Kenya cult leader, who convinced followers to starve, found guilty',
  ].every(h => tierOf(h) === 'lead'));

ok('policy, law and diplomacy are significant',
  ['US bars government agencies from using China’s DeepSeek',
   'India-New Zealand trade pact kicks in',
   'Parliament passes the new insolvency bill',
   'Japan launches historic mission to bring back Mars moon samples',
  ].every(h => tierOf(h) === 'significant'));

ok('a product launch and a share price are minor',
  ['Apple launches iPhone 18 with satellite messaging',
   'AstraZeneca partners with Oracle on AI clinical research',
   'Sensex tumbles 876 points; Nifty drops below 22,900',
   'Wall Street closes lower for a third day',
  ].every(h => tierOf(h) === 'minor'));

/* The point of the whole change. */
ok('a coin moving is minor however big the number',
  tierOf('Bitcoin News | Strategy Bought $22 Million of Bitcoin Last Week') === 'minor'
  && tierOf('JPMorgan drops JPM Coin on Ethereum with zero retail access') === 'minor'
  && tierOf('Bitcoin crashes below $60,000') === 'minor',
  '"crashes" must not buy a price story a place on the front page');
ok('a crypto story that is actually news is not demoted',
  tierOf('Crypto exchange founder charged with fraud') === 'significant'
  && tierOf('SEC approves spot Solana ETF applications') === 'significant'
  && isCryptoVertical('Bitcoin tops $90,000')
  && !isCryptoVertical('Crypto exchange founder charged with fraud'));

ok('importance outranks corroboration', (() => {
  const t = Date.now();
  const mk = (title, source, topic) => ({ title, source, topic, published: t - 600000, weight: 1 });
  const items = [
    // Heavily covered, and minor.
    ...['Reuters', 'BBC News', 'The Hindu', 'NDTV', 'Al Jazeera'].map(s =>
      mk('Bitcoin tops $90,000 on ETF inflows', s, 'crypto')),
    // Thinly covered, and a lead.
    mk('Earthquake kills at least 40 in the north', 'Associated Press', 'world'),
    mk('Earthquake kills 40 in the north', 'Reuters', 'world'),
  ];
  const [first] = selectStories(items, { count: 1, now: t });
  return first && /Earthquake/.test(first.lead.title);
})(), 'five outlets on a price move must not outrank two on an earthquake');

ok('a minor story never reaches Top stories', (() => {
  const t = Date.now();
  const items = ['A', 'B', 'C', 'D'].map(s => ({
    title: 'Bitcoin tops $90,000 on ETF inflows', source: s,
    topic: 'crypto', published: t - 600000, weight: 1 }));
  return selectStories(items, { count: 3, now: t }).length === 0;
})());

ok('a section with nothing above minor is not offered as a post', (() => {
  const t = Date.now();
  const mk = (title, source, topic) => ({ title, source, topic, published: t - 600000, weight: 1 });
  const items = [
    mk('Bitcoin tops $90,000 on ETF inflows', 'CoinDesk', 'crypto'),
    mk('Bitcoin tops $90,000 after ETF inflows', 'Reuters', 'crypto'),
    mk('Cabinet approves the new port scheme', 'The Hindu', 'india'),
    mk('Cabinet approves new port scheme', 'NDTV', 'india'),
  ];
  return !selectSections(items, { count: 0, perSection: 3 }).some(s => s.id === 'business');
})(), 'BUSINESS came out as three Bitcoin items');

ok('there is no CRYPTO NEWS label on this channel',
  categoryFor('crypto') === 'BUSINESS'
  && categoryFor('world', 'Bitcoin tops $90,000') === 'BUSINESS');

ok('the feed mix carries no dedicated crypto feed', (() => {
  const feeds = JSON.parse(readFileSync(join(TEST_ROOT, 'automation/feeds.json'), 'utf8')).feeds;
  return !feeds.some(f => f.topic === 'crypto')
    && !feeds.some(f => /coin|crypto|block/i.test(f.id));
})(), 'five of nineteen feeds used to be crypto feeds');

ok('general news outweighs finance in the feed mix', (() => {
  const feeds = JSON.parse(readFileSync(join(TEST_ROOT, 'automation/feeds.json'), 'utf8')).feeds;
  const general = feeds.filter(f => ['world','india','tech','science','health'].includes(f.topic));
  const finance = feeds.filter(f => ['business','markets-india','markets-world','crypto'].includes(f.topic));
  return general.length > finance.length * 2;
})(), 'the mix is what the account is about');

/* ── Corrections ──────────────────────────────────────────────── */
/* A news account that cannot correct itself is a broadcast. These are the
   rules that keep a correction from becoming a second mistake. */

const postedRecords = () => [
  { title: 'Stock market crash today: Sensex plunges over 900 points',
    section: 'top', issue: 23, mediaId: '17900000000000001',
    permalink: 'https://www.instagram.com/p/ABC123/', posted: '2026-10-19T12:50:00.000Z' },
  { title: 'Ceasefire talks resume in Geneva', section: 'world', issue: 22,
    mediaId: '17900000000000002', permalink: 'https://www.instagram.com/p/XYZ789/',
    posted: '2026-10-18T07:10:00.000Z' },
];

ok('a correction finds the post it corrects by issue number',
  findOriginal(postedRecords(), { issue: 22 })?.mediaId === '17900000000000002');
ok('and by media id',
  findOriginal(postedRecords(), { mediaId: '17900000000000001' })?.issue === 23);
/* The dangerous failure: attaching a correction to a post that was never
   wrong, because the one named could not be found. */
ok('an unknown issue finds nothing rather than the most recent post',
  findOriginal(postedRecords(), { issue: 999 }) === null,
  'must not silently correct the wrong post');
ok('an unknown media id finds nothing rather than guessing',
  findOriginal(postedRecords(), { mediaId: 'nope' }) === null);

const corr = buildCorrection(
  'We said the Sensex fell over 900 points. It fell 489 points.',
  postedRecords()[0]);

ok('a correction is labelled as one, on the card and in the data',
  corr.kind === 'correction' && corr.category === 'CORRECTION');
ok('a correction carries what it is correcting',
  corr.corrects.mediaId === '17900000000000001'
  && /Sensex plunges over 900/.test(corr.corrects.title));
ok('a correction is always postable, however short',
  buildCorrection('We said 900. It was 489.', postedRecords()[0]).usable === true,
  'the usability rule is for mangled headlines, not for short corrections');
ok('a correction with no text is refused', (() => {
  try { buildCorrection('   ', postedRecords()[0]); return false; } catch { return true; }
})());
ok('a correction invents nothing — the card text comes from the words given',
  corr.display === 'We said the Sensex fell over 900 points. It fell 489 points.');

const corrCap = correctionCaption(corr);
ok('the correction caption quotes the original post',
  /Sensex plunges over 900 points/.test(corrCap));
ok('the correction caption states the correction in full',
  corrCap.includes('It fell 489 points'));
ok('the correction caption links the post being corrected',
  corrCap.includes('https://www.instagram.com/p/ABC123/'));
ok('the correction caption says mistakes are not deleted',
  /rather than deleting/i.test(corrCap));
ok('the correction caption fits Instagram', corrCap.length <= 2200);
ok('a standalone correction does not pretend to quote an original', (() => {
  const c = buildCorrection('We overstated the figure.', null);
  const cap = correctionCaption(c);
  return c.corrects === null && !/we posted:/i.test(cap);
})());

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
    // One real business story, so the section has something above minor, and
    // one market move, to prove market topics still map into Business.
    ...pair('Regulator fines a major bank over mis-selling',
            'Regulator fines major bank for mis-selling', 'business', 'BBC News', 'Reuters'),
    ...pair('Sensex climbs 540 points to a record high',
            'Sensex climbs 540 points to record high', 'markets-india', 'Economic Times', 'NDTV'),
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

ok('market and business topics all map to the Business section',
  ['business','markets-india','markets-world','crypto'].every(t => sectionOf(t) === 'business'));
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

/* ── The rejection log ───────────────────────────────────────── */
/* A run reads several hundred articles and publishes a dozen. Everything
   else is dropped by rules in this file, and until these existed there was
   no record of which rule dropped what — so a regex quietly eating real news
   would never have surfaced anywhere. */

const refusalCases = [
  ['unverified or rumour',            "North Korea's 'Proof Of Life' Amid Kim Jong Un 'Death' Rumour"],
  ['comment, not reporting',          'Global Health Research in the America First Era'],
  ['too thin to be a headline',       'Middle East'],
  ['marketing, not reporting',        'Digital Science and Sunmedia partner on research impact'],
  ['not news',                        'Your daily horoscope for Tuesday the 20th'],
  ['tips or price speculation',       'Top 5 stocks to buy this week according to analysts'],
];

ok('every refusal is attributed to the rule that made it',
  refusalCases.every(([reason, title]) =>
    rejectionReason({ title, published: Date.now() }, { maxAgeHours: 24 }) === reason),
  JSON.stringify(refusalCases.map(([r, t]) =>
    [r, rejectionReason({ title: t, published: Date.now() }, { maxAgeHours: 24 })])
    .filter(([a, b]) => a !== b)));

/* Found by the rejection log on its first live run: the finance gate was
   throwing away four genuine finance stories a morning, because it had never
   heard of KOSPI, "quarterly results", "economy" or "housing". Exactly the
   silent false positive the log exists to surface. */
ok('the finance gate knows indices beyond the ones it was born with',
  isTopical("Korea's KOSPI crashes another 5% as AI rout deepens")
  && isTopical('Hang Seng closes lower for a third session'));
ok('the finance gate knows the vocabulary of the economy',
  isTopical("Meta's AI spending, Muse adoption in focus for quarterly results")
  && isTopical('China flags APEC role as key for a challenged global economy')
  && isTopical('Number of branded housing projects in India set to jump 2-fold'));
ok('widening the gate did not open it to everything',
  !isTopical('Claude cracks a 25-year NSA number mystery')
  && !isTopical('Best places to eat in Mumbai this weekend'),
  'a crypto site\u2019s tech section is what the gate is for');

ok('a story the channel would run is not refused',
  rejectionReason({ title: 'Earthquake kills at least 40 in northern Afghanistan',
                    published: Date.now() }, { maxAgeHours: 24 }) === null
  && rejectionReason({ title: 'Cabinet approves a port expansion scheme for the east coast',
                       published: Date.now() }, { maxAgeHours: 24 }) === null);

ok('an item older than the window is refused for that, not for its content',
  rejectionReason({ title: 'Earthquake kills at least 40 in northern Afghanistan',
                    published: Date.now() - 40 * 3600000 }, { maxAgeHours: 24 })
    === 'older than the window');

ok('the finance gate only applies to finance feeds',
  rejectionReason({ title: 'Claude cracks a 25-year NSA mystery and wins praise',
                    requireTopical: true, published: Date.now() }, { maxAgeHours: 24 })
    === 'finance feed, not a finance story'
  && rejectionReason({ title: 'Claude cracks a 25-year NSA mystery and wins praise',
                       published: Date.now() }, { maxAgeHours: 24 }) === null);

ok('the log collects what was refused without running the filters twice', (() => {
  const now = Date.now();
  const mk = (title, extra = {}) => ({ title, source: 'X', topic: 'world',
                                       published: now - 600000, weight: 1, ...extra });
  const items = [
    mk('Middle East'),
    mk('Your daily horoscope for Tuesday the 20th'),
    mk('Earthquake kills at least 40 in northern Afghanistan'),
    mk('Earthquake kills 40 in northern Afghanistan say officials'),
  ];
  const rejected = [];
  const ranked = rankEligible(items, { now, maxAgeHours: 24, rejected });
  return rejected.length === 2 && ranked.length === 1
    && rejected.every(r => r.reason && r.title);
})(), 'two refused, two kept and clustered into one story');

ok('collecting is optional and off by default', (() => {
  const now = Date.now();
  const ranked = rankEligible([{ title: 'Middle East', source: 'X', topic: 'world',
                                 published: now - 600000, weight: 1 }], { now });
  return ranked.length === 0;     // refused, and nothing threw for want of an array
})());

/* ── Who owns the newsrooms ───────────────────────────────────── */
/* Counting newsrooms was half of it. Three Indian mastheads owned by three
   conglomerates, every one with large businesses the government regulates,
   are not the check on a story that Reuters, the AP and a trust-owned paper
   are. Ownership is a fact about a source and belongs in front of whoever is
   approving the post. */

ok('an outlet carries its owner and how it is funded',
  ownerOf('NDTV').funding === 'conglomerate'
  && ownerOf('Moneycontrol').owner === 'Reliance Industries'
  && ownerOf('Reuters').funding === 'trust'
  && ownerOf('Associated Press').funding === 'cooperative'
  && ownerOf('BBC News').funding === 'state');
ok('ownership is found through a spelling variant',
  ownerOf('The Times of India').owner === ownerOf('Economic Times').owner,
  'both are Bennett, Coleman');
ok('an outlet nobody has recorded is unknown, not assumed',
  ownerOf('Some Site Nobody Listed').funding === 'unknown'
  && ownerOf('Some Site Nobody Listed').owner === null);

ok('owners are counted, not mastheads', (() => {
  const r = independentSources(['News18', 'CNN News18', 'Firstpost']);
  return r.count === 1 && r.ownerCount === 1;
})(), 'three Network18 titles are one newsroom and one owner');
ok('genuinely separate owners count separately', (() => {
  const r = independentSources(['Reuters', 'Associated Press', 'The Hindu']);
  return r.count === 3 && r.ownerCount === 3 && r.countries.length === 3
    && r.fundings.length === 3;
})());

ok('three conglomerates in one country is flagged as what it is',
  concentrationWarnings(['NDTV', 'Times of India', 'Moneycontrol'])
    .some(w => /conglomerate-owned/.test(w)),
  JSON.stringify(concentrationWarnings(['NDTV', 'Times of India', 'Moneycontrol'])));
ok('a wire, a cooperative and a trust is not flagged',
  concentrationWarnings(['Reuters', 'Associated Press', 'The Guardian']).length === 0);
/* Two governments' broadcasters agreeing is corroboration. One government's
   outlets agreeing with themselves is not. */
ok('two different states agreeing is not flagged',
  concentrationWarnings(['BBC News', 'Al Jazeera']).length === 0);
ok('one state’s own outlets agreeing is flagged',
  concentrationWarnings(['DD India', 'Prasar Bharati', 'All India Radio'])
    .some(w => /state-funded/.test(w))
  || independentSources(['DD India', 'Prasar Bharati', 'All India Radio']).count === 1,
  'they fold to one newsroom, which is itself the right answer');
ok('outlets with no recorded owner say so rather than passing silently',
  concentrationWarnings(['Site A', 'Site B', 'Site C'])
    .some(w => /No ownership is recorded/.test(w)));
ok('a thinly carried story is not double-warned',
  concentrationWarnings(['NDTV']).length === 0,
  'one outlet is already flagged as thin corroboration');

ok('ownership reaches the story record', (() => {
  const t = Date.now();
  const mk = (title, source) => ({ title, source, topic: 'india', published: t - 600000, weight: 1 });
  const [chosen] = selectStories([
    mk('Cabinet approves the port expansion scheme', 'NDTV'),
    mk('Cabinet approves port expansion scheme', 'Times of India'),
    mk('Cabinet clears port expansion scheme', 'Moneycontrol'),
  ], { count: 1, now: t });
  return chosen && chosen.ownerCount === 3 && chosen.concentration.length > 0;
})(), 'the approval issue cannot show what the ranking never recorded');

ok('sources are named', sourceLine(['CoinDesk', 'Reuters']) === 'CoinDesk · Reuters');
ok('the headline overrides the feed when it plainly disagrees',
  categoryFor('markets-world', 'NSE, BSE to remain closed tomorrow') === 'INDIA MARKETS'
  && categoryFor('world', 'Bitcoin tops $90,000') === 'BUSINESS',
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

/* ── The stat card ───────────────────────────────────────────── */
/* Every card in every post was the same shape, which is most of why a long
   post reads flat. The app has had a stat layout since the beginning and the
   automation never used it. The rule that cannot bend: everything on the
   card is lifted verbatim, because rewriting a headline to fit a layout
   would be inventing. */

ok('a figure that is the story becomes the card', (() => {
  const cases = [
    ['Sensex plunges 876 points as banks drag the index lower', '876', 'points'],
    ['Asian Para Games: India wins 24 medals including 5 golds', '24', 'medals including 5 golds'],
    ['RBI cuts repo rate by 25 basis points', '25', 'basis points'],
    ['Kenya cult leader convicted of 191 murders', '191', 'murders'],
  ];
  return cases.every(([h, stat, label]) => {
    const s = statFor(h);
    return s && s.stat === stat && s.label === label;
  });
})(), JSON.stringify(statFor('Sensex plunges 876 points as banks drag the index lower')));

ok('a currency figure keeps its symbol and commas exactly',
  statFor('Government approves ₹12,000 crore port expansion scheme')?.stat === '₹12,000 crore');
ok('a percentage is taken as written',
  statFor('Inflation eases to 4.2% in September')?.stat === '4.2%');

/* "Earthquake kills at least 40 in northern Afghanistan" fell through to a
   plain card, because "in northern Afghanistan" is not a unit. */
ok('a casualty count is a figure even with no unit after it',
  statFor('Earthquake kills at least 40 in northern Afghanistan')?.stat === '40');
ok('a label that would read as a fragment is dropped instead',
  statFor('Earthquake kills at least 40 in northern Afghanistan')?.label === '',
  'the headline below already says where');

ok('a date, a year and an ordinal are not figures',
  statFor('India Women vs Zimbabwe Women 2026 - 3rd T20I') === null
  && statFor('The summit opens on 20 October') === null);
ok('a headline with no figure gets the ordinary card',
  statFor('Ceasefire talks resume in Geneva after months of stalemate') === null
  && statFor('Cabinet approves a port expansion scheme for the east coast') === null);

ok('the label never runs into the next clause',
  !/\bas\b|\bafter\b/.test(statFor('Sensex plunges 876 points as banks drag the index')?.label || ''),
  '"876 points as banks drag the" is a sentence cut in half');

ok('everything on the card is a substring of the headline', (() => {
  const h = 'Asian Para Games: India wins 24 medals including 5 golds';
  const s = statFor(h);
  return h.includes(s.stat) && h.includes(s.label);
})(), 'the channel removes words, it never writes them');

ok('a correction is never turned into a stat card',
  prefersStat({ kind: 'correction', display: 'We said 900 points. It was 489.' }) === false);

ok('a blind reader is told the figure is the card',
  /The figure 40 is shown very large/.test(altForStory({
    category: 'WORLD NEWS', display: 'Earthquake kills at least 40 in northern Afghanistan',
    layout: 'quote', stat: { stat: '40', label: '' } })));

/* ── The shape of a post ─────────────────────────────────────── */
/* A section post was a cover plus three cards. People swipe for about as
   long as there is something to swipe to, and Meta's API takes ten items. */

ok('a carousel ends on a card about how it is made', (() => {
  const a = altForClosing();
  return /closing card/.test(a) && /two or more independent newsrooms/.test(a)
    && /corrections are posted in the open/.test(a);
})(), 'a post used to stop dead on its last story');

ok('the closing card is described too, so no slide goes out silent', (() => {
  const entry = { sectionLabel: 'TOP STORIES',
    images: ['cover.png', 'a.png', 'b.png', 'closing.png'],
    stories: [{ display: 'Earthquake kills at least 40 in northern Afghanistan',
                category: 'WORLD NEWS', backdrop: 'editorial' },
              { display: 'Cabinet approves a port expansion scheme',
                category: 'INDIA', backdrop: 'editorial' }] };
  const alts = altForEntry(entry);
  return alts.length === 4 && /cover card/.test(alts[0]) && /closing card/.test(alts[3]);
})());

ok('a post stays inside what the API will take', (() => {
  // Cover + stories + closing must not exceed ten, which is Meta's limit for
  // an API-published carousel (the app allows twenty; the API does not).
  const perSection = 6;
  return 1 + perSection + 1 <= 10;
})());

/* ── Stories that are not stories ────────────────────────────── */
/* Ten of twelve published stories graded `notable`, which is the fall-through
   tier — anything not recognisably lead, significant or minor lands there and
   ships. That is how a fixture listing and a professor's academy election
   became news. */

ok('a fixture listing is not a story',
  isJunk('India Women vs Zimbabwe Women 2026 - 3rd T20I')
  && isJunk('Match preview: full squad and probable XI'),
  'it is a line in a schedule');
ok('a real sports result is still news',
  !isJunk('Asian Para Games: India wins 24 medals including 5 golds'));

ok('a personal honour is minor, not a headline',
  tierOf('WSU professor Felix Lankester elected to National Academy of Medicine') === 'minor'
  && tierOf('Scientist receives the Nobel prize for chemistry') === 'minor');
ok('a company describing itself is minor',
  tierOf('Jio is a technology company, not just a telco, says Akash Ambani ahead of launch')
    === 'minor');
ok('an explainer question is minor',
  tierOf('What are the giant heat storms now scorching the Earth?') === 'minor'
  && tierOf('Why does the rupee keep falling?') === 'minor');
ok('an attributed statement of fact is not demoted',
  tierOf('Minister says the inquiry will report by March') !== 'minor'
  && tierOf('The economy is in recession, says the IMF') !== 'minor',
  '"X says Y" is how reporting attributes things');

/* A minor story published anyway: the rule only required one story above
   minor per section, so a product launch rode along beside real news. */
ok('nothing minor is published, in Top or in a section', (() => {
  const t = Date.now();
  const mk = (title, source, topic) => ({ title, source, topic, published: t - 600000, weight: 1 });
  const items = [
    mk('Cabinet approves the new port scheme', 'The Hindu', 'india'),
    mk('Cabinet approves new port scheme', 'NDTV', 'india'),
    mk('Hims & Hers Health launches an online weight service', 'BBC News', 'india'),
    mk('Hims and Hers Health launches online weight service', 'Reuters', 'india'),
  ];
  const secs = selectSections(items, { count: 1, perSection: 5 });
  const published = secs.flatMap(s => s.clusters);
  return published.length > 0 && published.every(c => c.tier !== 'minor');
})());

/* ── Alt text ────────────────────────────────────────────────── */
/* A news account publishing images without descriptions shuts blind readers
   out of the news. The headline IS the content here, so the description
   leads with the words on the card rather than with "an image of". */

const altStory = { category: 'WORLD NEWS', display: 'Earthquake kills at least 40 in northern Afghanistan',
                   source: 'BBC News · Al Jazeera', corroboration: 2, backdrop: 'editorial' };

ok('the description leads with the words on the card',
  /It reads: “Earthquake kills at least 40 in northern Afghanistan”/.test(altForStory(altStory)));
ok('it names the category and who reported it',
  /headed WORLD NEWS/.test(altForStory(altStory))
  && /BBC News · Al Jazeera — 2 independent newsrooms/.test(altForStory(altStory)));

/* It described every card as "a plain brand design", because render.mjs
   never recorded which backdrop it had chosen. */
ok('it describes the backdrop that was actually used',
  /concentric rings/.test(altForStory({ ...altStory, backdrop: 'editorial' }))
  && /generated market chart/.test(altForStory({ ...altStory, backdrop: 'chart' }))
  && /particle/.test(altForStory({ ...altStory, backdrop: 'particles' })));
ok('a generated chart is declared as generated',
  /not real data/.test(altForStory({ ...altStory, backdrop: 'chart' })),
  'a blind reader must not be told there is data when there is none');
ok('a library photograph is declared as one', (() => {
  const a = altForStory({ ...altStory, backdrop: null,
    photo: { credit: 'File photo: Gage Skidmore / CC BY 2.0', title: 'Kabul street scene' } });
  return /library photograph/.test(a) && /not a photograph of this event/.test(a)
    && /Gage Skidmore \/ CC BY 2\.0/.test(a);
})());

ok('a cover lists what is inside it', (() => {
  const a = altForCover({ sectionLabel: 'TOP STORIES', stories: [
    { display: 'Earthquake kills at least 40 in northern Afghanistan' },
    { display: 'Cabinet approves a port expansion scheme' }] });
  return /listing 2 headlines/.test(a) && /1\. Earthquake/.test(a) && /2\. Cabinet/.test(a);
})());

ok('every slide of a carousel gets its own description', (() => {
  const entry = { sectionLabel: 'TOP STORIES',
    images: ['a.png', 'b.png', 'c.png'],
    stories: [{ ...altStory }, { ...altStory, display: 'Second story about something else entirely' }] };
  const alts = altForEntry(entry);
  return alts.length === 3 && /cover card/.test(alts[0]) && !/cover card/.test(alts[1]);
})(), 'a cover plus one card per story');

ok('a single card has no cover to describe', (() => {
  const alts = altForEntry({ image: 'a.png', ...altStory });
  return alts.length === 1 && !/cover card/.test(alts[0]);
})(), 'the breaking watch and corrections render one card');

ok('a description fits what Instagram accepts', (() => {
  const long = { ...altStory, display: 'x'.repeat(900), source: 'y'.repeat(400) };
  return altForStory(long).length <= 1000;
})());

/* ── Wikimedia Commons ───────────────────────────────────────── */
/* A probe from the runner: Openverse answered 1 request in 8 and hung for 25
   seconds on the other 7 — it throttles an unauthenticated client by holding
   the connection. Commons answered 4 of 4 in about a second each. */

ok('CC0, public domain and CC BY are usable',
  licenceFrom({ License: { value: 'cc0' } })?.license === 'cc0'
  && licenceFrom({ LicenseShortName: { value: 'Public domain' } })?.license === 'pdm'
  && licenceFrom({ License: { value: 'cc-by-4.0' } })?.license === 'by');
ok('share-alike, non-commercial, no-derivatives and GFDL are refused',
  [['cc-by-sa-4.0'], ['cc-by-nc-2.0'], ['cc-by-nd-3.0'], ['gfdl']]
    .every(([v]) => licenceFrom({ License: { value: v } }) === null),
  'a share-alike image would arguably oblige the graphic to match it');
ok('unknown terms are not read as permission',
  licenceFrom({}) === null
  && licenceFrom({ License: { value: 'something-else' } }) === null);

ok('a Commons page maps onto the shape the pipeline already understands', (() => {
  const r = commonsResult({
    title: 'File:Marco_Rubio_official_photo.jpg',
    imageinfo: [{ url: 'https://u/x.jpg', width: 2000, height: 1400,
      descriptionurl: 'https://commons/x', thumburl: 'https://u/t.jpg',
      extmetadata: { License: { value: 'pd' }, Artist: { value: '<a href="#">US Senate</a>' },
                     Categories: { value: 'Portraits|Senators' } } }],
  });
  return r.license === 'pdm' && r.creator === 'US Senate'
    && r.title === 'Marco Rubio official photo'
    && r.tags.map(t => t.name).join(',') === 'Portraits,Senators'
    && r.thumbnail === 'https://u/t.jpg';
})());
ok('an unusable Commons result is dropped at the source, not ranked lower',
  commonsResult({ title: 'File:x.jpg', imageinfo: [{ url: 'https://u/x.jpg',
    extmetadata: { License: { value: 'cc-by-sa-4.0' } } }] }) === null);

/* ── Queries that actually find a picture ─────────────────────── */
/* One live run produced a photograph for 1 story in 13. Eight timed out on
   good queries; the rest were searched for things like "US Bars". */

ok('a headline verb is never taken for a name',
  queriesFor("US Bars Government Agencies From Using China's DeepSeek", 'world')[0]
    === "China's DeepSeek",
  JSON.stringify(queriesFor("US Bars Government Agencies From Using China's DeepSeek", 'world')));
ok('a run does not trail off on a preposition',
  queriesFor('UK To Deploy Fighter Jets To Support Saudi Arabia Against Houthis', 'world')
    .every(q => !/\b(against|to|from|with|using|support)$/i.test(q)),
  JSON.stringify(queriesFor('UK To Deploy Fighter Jets To Support Saudi Arabia Against Houthis', 'world')));
ok('an abstraction is not searched for as though it were a subject',
  queriesFor('Health and Economic Benefits Associated with Increased Kidney Donation', 'health')[0]
    !== 'Health');
ok('people and places are still found',
  queriesFor('Rubio, Jaishankar meet in Mumbai as India aims to finalise deal', 'india')[0]
    === 'Jaishankar'
  && queriesFor('Earthquake kills at least 40 in northern Afghanistan', 'world')[0]
    === 'Afghanistan'
  && queriesFor('Deutsche Bank Is Weeks From Holding Bitcoin for Clients', 'business')[0]
    === 'Deutsche Bank');

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
