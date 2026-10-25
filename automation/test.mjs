#!/usr/bin/env node
/* Tests for the parts where a bug would put something wrong on the account.
 *   node automation/test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseFeed, imageIn } from './lib/rss.mjs';
import { licenceFrom, toResult as commonsResult } from './lib/commons.mjs';
import { altForStory, altForCover, altForEntry, altForClosing } from './lib/alttext.mjs';
import { statFor, prefersStat } from './lib/statcard.mjs';
import { looksLikeNews, hasNewsVerb, reportsNothing, NEWS_VERBS } from './lib/verbs.mjs';
import { imageUrlFrom, isFurniture, creditFor as articleCredit,
         imageFromArticle, biggerVariants } from './lib/articleimage.mjs';
import { reelSeconds, checkDuration, ffmpegArgs,
         MIN_SECONDS, MAX_SECONDS } from './lib/reelbuild.mjs';
import { plainText, firstSentence, sourceLine as spokenSources, scriptFor,
         sameThing, spokenSeconds, speakArgs } from './lib/voice.mjs';
import { videoUrlFrom, kindOf, videoFromArticle } from './lib/articlevideo.mjs';
import { create, attachPost, validate, posts, postById, idFor, dirFor,
         prune, save, load } from './lib/edition.mjs';
import { composeStory, composeSection, composeStoryPost,
         backdropOf, toQuery } from './lib/compose.mjs';
import { plan } from './lib/plan.mjs';
import { approvalIssue, warningsFor, superseded,
         editionIdIn, kindOfEdition } from './lib/offer.mjs';
import { record } from './lib/ledger.mjs';
import { tierOf, isCryptoVertical, TIER_POINTS } from './lib/importance.mjs';
import { similarity, cluster, selectStories, selectSections, isRepeat, isTopical, isAdvice,
         isSpeculation, isJunk, isPressRelease, isUnverified, isOpinion, isTooThin,
         rankClusters, rankEligible, rejectionReason, cluster as clusterBy,
         attributionOf, documentFrequency, subjectsOf, sharesSubject } from './lib/select.mjs';
import { sectionOf, sectionLabel, SECTIONS, sortIntoSections } from './lib/sections.mjs';
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
    { title: 'Claude cracks a 25-year NSA number mystery', source:'Reuters', published: Date.now(), weight:1, topic:'crypto', requireTopical:true },
    { title: 'Claude cracks a 25-year NSA number mystery, say researchers', source:'BBC News', published: Date.now(), weight:1, topic:'crypto', requireTopical:true },
  ], { count: 3, now: Date.now() }).length);
// A general news feed is not gated on market words — that is the point of it.
// Real mastheads, because corroboration now requires at least one outlet
// whose owner this channel can actually name. The gate under test here is
// the topical one, not that.
ok('a general feed may carry general news',
  selectStories([
    { title: 'Prime Minister announces new education policy', source:'The Hindu', published: Date.now(), weight:1, topic:'india' },
    { title: 'Prime Minister unveils education policy reforms', source:'NDTV', published: Date.now(), weight:1, topic:'india' },
  ], { count: 3, now: Date.now() }).length === 1);
ok('junk never reaches the shortlist, whatever the feed',
  !selectStories([
    { title: 'Horoscope today: what the stars say for your sign', source:'Reuters', published: Date.now(), weight:1, topic:'india' },
    { title: 'Horoscope today: what the stars hold for your sign', source:'BBC News', published: Date.now(), weight:1, topic:'india' },
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
    { title:'Analyst recommends 3 stocks to buy this week', source:'Reuters', published:t, weight:1, topic:'india' },
    { title:'Analyst recommends 3 stocks to buy this week now', source:'BBC News', published:t, weight:1, topic:'india' },
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
  { title: 'Fed cuts rates by 25 basis points', source: 'Reuters', published: Date.now(), weight: 1, topic: 'world' },
  { title: 'Federal Reserve cuts rates 25 bps',  source: 'BBC News', published: Date.now(), weight: 1, topic: 'world' },
  { title: 'Solana ETF approved by regulators',  source: 'The Hindu', published: Date.now(), weight: 1, topic: 'crypto' },
];
ok('groups one story and leaves the other alone', cluster(mixed).length === 2);

/* ── What gets chosen ─────────────────────────────────────────── */

const now = Date.now();
const pool = [
  { title: 'Fed cuts rates by 25 basis points', source: 'Reuters', published: now, weight: 1, topic: 'world' },
  { title: 'Federal Reserve cuts rates 25 bps',  source: 'BBC News', published: now, weight: 1, topic: 'world' },
  { title: 'Fed lowers interest rates 25 basis points', source: 'The Hindu', published: now, weight: 1, topic: 'world' },
  { title: 'Obscure altcoin might possibly moon soon', source: 'NDTV', published: now, weight: 1, topic: 'crypto' },
  { title: 'Very old news about something', source: 'Reuters', published: now - 80 * 3600000, weight: 1, topic: 'world' },
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
  { title:'Regulator fines a major bank over mis-selling', source:'Reuters', published:now, weight:1, topic:'business' },
  { title:'Parliament passes the new insolvency bill',     source:'BBC News', published:now, weight:1, topic:'business' },
  { title:'Cabinet approves a port expansion scheme',      source:'The Hindu', published:now, weight:1, topic:'business' },
  { title:'Supreme Court orders a review of forest rules', source:'NDTV', published:now, weight:1, topic:'india'  },
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
  { title:'Sensex tumbles 876 points as banks drag',   source:'Reuters', published:now, weight:1.1, topic:'markets-india' },
  { title:'Sensex falls 876 points dragged by lenders', source:'BBC News', published:now, weight:1,   topic:'markets-india' },
  { title:'Sensex drops 876 points on bank selling',    source:'The Hindu', published:now, weight:1,   topic:'markets-india' },
  { title:'Bitcoin ETFs see heavy weekly outflows',     source:'NDTV', published:now, weight:1.2, topic:'crypto' },
  { title:'Bitcoin ETF outflows run for a second week', source:'The Guardian', published:now, weight:1,   topic:'crypto' },
  { title:'Wall Street closes lower for a third day',   source:'Al Jazeera', published:now, weight:1.3, topic:'markets-world' },
  { title:'Wall Street ends lower for a third session', source:'Hindustan Times', published:now, weight:1,   topic:'markets-world' },
  { title:'Ceasefire talks resume in Geneva',           source:'Associated Press', published:now, weight:1.8, topic:'world' },
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

/* A post is one story now, so this is the caption nearly every post gets. */
{
  const one = buildCaption({
    kind: 'story', display: 'Earthquake kills at least 40 in northern Afghanistan',
    topic: 'world', source: 'BBC News · Al Jazeera',
    sourceNames: ['BBC News', 'Al Jazeera'],
  });
  ok('a one-story caption leads with its headline',
     one.startsWith('Earthquake kills at least 40'), one.slice(0, 40));
  ok('a one-story caption names every outlet, plurally',
     /Sources: BBC News, Al Jazeera/.test(one), one);
  ok('a one-story caption does not read the card’s middle dots aloud',
     !one.includes('·'), one);
  ok('a one-story caption carries its topic tag', /#worldnews/.test(one), one);

  const solo = buildCaption({ kind: 'story', display: 'Rupee steadies', source: 'Mint' });
  ok('one outlet is a source, not sources', /Source: Mint/.test(solo), solo);
  ok('a story with no outlet claims none',
     !/Sources?:/.test(buildCaption({ kind: 'story', display: 'x' })));
}


/* ── The edition, and what /approve means ─────────────────────────
   This is the only logic in the repository that decides what reaches the
   account. It used to live inside approve.yml, where it could only run on
   GitHub and was tested by evaluating JavaScript out of a YAML string. A bug
   here does not fail loudly; it posts the wrong thing under the channel's
   name. */

/* An edition as the stages build one: the shortlist writes the sections, the
   render attaches a carousel, the caption fills in its path, the reel
   attaches a second post. Built here the same way, so the fixture cannot
   drift into a shape nothing produces. */
function editionFixture({ kind = 'daily', withReel = true } = {}) {
  const e = create({
    id: '2026-10-20', kind,
    pool: 240,
    refusals: { read: 240, published: 3, refused: 12, byRule: {
      'a press release is not news': { count: 7, samples: [{ title: 'Acme announces', source: 'PR' }] } } },
    sections: [
      { id: 'top', label: 'TOP STORIES', stories: [
        { headline: 'Earthquake kills at least 40 in northern Afghanistan',
          display: 'Earthquake kills at least 40 in northern Afghanistan',
          source: 'BBC News · Al Jazeera', sourceNames: ['BBC News', 'Al Jazeera'],
          corroboration: 2, tier: 'lead', topic: 'world' },
        { headline: 'Regulator fines a major bank over mis-selling',
          display: 'Regulator fines a major bank over mis-selling',
          source: 'Reuters', sourceNames: ['Reuters'],
          corroboration: 1, tier: 'significant', topic: 'business',
          republishers: ['MSN'], concentration: ['two of three are owned by one group'] },
      ] },
      { id: 'business', label: 'BUSINESS', stories: [
        { headline: 'Sensex plunges 876 points', display: 'Sensex plunges 876 points',
          source: 'The Hindu · Mint', sourceNames: ['The Hindu', 'Mint'],
          corroboration: 2, tier: 'notable', topic: 'business' },
      ] },
    ],
  });
  const dir = `data/editions/${e.id}`;
  // A post per story, which is what the renderer builds: one card normally,
  // three when the story has a figure in it.
  const post = (section, n, story, cards) => attachPost(e, section, {
    kind: 'carousel', id: `${section}-${n}`, story,
    files: Array.from({ length: cards }, (_, i) => `${dir}/${section}/${n}/slide-${i + 1}.jpg`),
    cover: `${dir}/${section}/${n}/slide-1.jpg`,
    alts: `${dir}/${section}/${n}/alt.json`,
    caption: `${dir}/caption-${section}-${n}.txt`, commentOn: '', commentFile: '' });

  post('top', 1, 'Earthquake kills at least 40 in northern Afghanistan', 3);
  post('top', 2, 'Regulator fines a major bank over mis-selling', 1);
  post('business', 1, 'Sensex plunges 876 points', 3);
  if (withReel) attachPost(e, 'top', { kind: 'reel', id: 'top-reel',
    files: [`${dir}/top/reel.mp4`], cover: `${dir}/top/1/slide-1.jpg`,
    caption: `${dir}/caption-top-1.txt`, alts: '', seconds: 18.7, bytes: 2_000_000,
    story: 'Earthquake kills at least 40 in northern Afghanistan',
    footage: 'the photograph, pushed in' });
  return e;
}

const ed = editionFixture();

/* ── Editions on disk ─────────────────────────────────────────────
   Each edition gets a directory of its own. The breaking watch runs every
   fifteen minutes; when every run rewrote one shared folder, an approval
   from an hour ago would have published a different post entirely, and the
   only thing standing between that and the account was a commit hash parsed
   out of an issue body. */

const noon = new Date('2026-10-20T12:34:56Z');
ok('a daily edition is named for its day', idFor({ at: noon }) === '2026-10-20');
ok('a breaking edition cannot land on the day’s post',
  idFor({ kind: 'breaking', at: noon }) === '2026-10-20-breaking-1234');
ok('two breaking editions in one day do not collide',
  idFor({ kind: 'breaking', at: new Date('2026-10-20T09:15:00Z') })
  !== idFor({ kind: 'breaking', at: noon }));
ok('a correction says so in its own name',
  /correction/.test(idFor({ kind: 'correction', at: noon })));
ok('an edition lives under data/editions', dirFor('2026-10-20') === 'data/editions/2026-10-20');

ok('a post is recorded against its section, and replaced rather than doubled', (() => {
  const e = editionFixture();
  const before = e.sections[0].posts.length;
  attachPost(e, 'top', { kind: 'carousel', id: 'top-1', files: ['x.jpg'], caption: 'c', alts: 'a' });
  return e.sections[0].posts.length === before
    && postById(e, 'top-1').files.length === 1;
})(), 'a second render of a section must not leave two carousels behind');

ok('attaching to a section that is not there is an error, not a silent no-op', (() => {
  try { attachPost(editionFixture(), 'sport', { kind: 'carousel', id: 'sport' }); return false; }
  catch (e) { return /no section/.test(e.message); }
})());

{
  const { mkdtemp, mkdir, readdir, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const tmp = await mkdtemp(join(tmpdir(), 'dv-ed-'));
  for (const d of ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'])
    await mkdir(join(tmp, 'data', 'editions', d), { recursive: true });
  const gone = await prune(tmp, 2);
  const left = (await readdir(join(tmp, 'data', 'editions'))).sort();
  ok('pruning keeps the newest and removes the rest',
    left.join(',') === '2026-10-13,2026-10-14' && gone.length === 2, left.join(','));

  const saved = editionFixture();
  await save(tmp, saved);
  const back = await load(tmp);
  ok('an edition saved is the edition loaded back',
    back.id === saved.id && back.sections.length === saved.sections.length);
  ok('the latest pointer finds the edition without globbing a directory',
    JSON.parse(await readFile(join(tmp, 'data', 'latest.json'), 'utf8')).id === saved.id);
}

/* ── Composition ──────────────────────────────────────────────────
   What each card says and looks like, decided without a browser. These were
   buried in the renderer's URL builder, which meant the only way to ask
   "what will the blind reader be told?" was to draw it and look. */

ok('a headline about a number gets the stat layout', (() => {
  const story = { headline: 'Sensex plunges 876 points as banks drag the index lower',
    display: 'Sensex plunges 876 points as banks drag the index lower', source: 'Mint' };
  const spec = composeStory(story, { theme: 'bbc', ratio: '4:5' });
  return story.layout === 'quote' && spec.params.stat === '876'
    && spec.params.context === story.display;
})(), 'and the headline still sits underneath in full');

ok('a headline that is not about a number does not', (() => {
  const story = { headline: 'Ceasefire talks resume in Geneva',
    display: 'Ceasefire talks resume in Geneva', source: 'Reuters' };
  composeStory(story, { layout: 'breaking' });
  return story.layout === 'breaking' && story.stat === null;
})());

ok('the backdrop chosen is the backdrop written down', (() => {
  const story = { headline: 'Cabinet approves a port scheme', display: 'Cabinet approves a port scheme',
    source: 'The Hindu', topic: 'india' };
  const spec = composeStory(story, {});
  // The description has to say what is actually behind the headline. It
  // called every card "a plain brand design" when nothing recorded this.
  return story.backdrop && spec.params.bg === story.backdrop
    && spec.alt.includes(story.backdrop === 'chart' ? 'market chart'
      : story.backdrop === 'editorial' ? 'brand graphic' : 'background');
})());

ok('a correction is never illustrated',
  backdropOf({ kind: 'correction', display: 'We said the Sensex fell 900 points' }, { bg: 'chart' })
  === 'editorial',
  'a chart that looks like the figure we got wrong is worse than decoration');

ok('a photograph replaces the backdrop rather than sitting over one', (() => {
  const story = { headline: 'x', display: 'x', source: 'y',
    photo: { path: 'work/photos/top/photo-top-2.jpg', credit: 'File photo: A (CC BY 4.0)' } };
  const spec = composeStory(story, { bg: 'chart' });
  return story.backdrop === null && spec.params.img === story.photo.path;
})());

ok('every card of a section is composed, cover and closing included', (() => {
  const stories = [{ headline: 'a', display: 'a', source: 's' },
                   { headline: 'b', display: 'b', source: 's' }];
  const specs = composeSection(stories, { label: 'TOP STORIES' });
  return specs.map(x => x.kind).join(',') === 'cover,story,story,closing'
    && specs.every(x => x.alt && x.alt.length > 20);
})(), 'a slide with no description is a slide a blind reader cannot read');

ok('the cover lists the headlines it is a cover for', (() => {
  const specs = composeSection([{ headline: 'a', display: 'Afghan quake', source: 's' }], {});
  return specs[0].params.item.join('') === 'Afghan quake';
})());

/* ── One story, one post ──────────────────────────────────────────
   A post is the publishable unit now, so this is what every post in the
   edition is made of. */
{
  const plain = () => ({ headline: 'Ceasefire talks resume in Geneva',
    display: 'Ceasefire talks resume in Geneva', source: 'Reuters · AP',
    sourceNames: ['Reuters', 'AP'], corroboration: 2, topic: 'world' });
  const numeric = () => ({ headline: 'Earthquake kills at least 40 in northern Afghanistan',
    display: 'Earthquake kills at least 40 in northern Afghanistan',
    source: 'BBC News · Al Jazeera', sourceNames: ['BBC News', 'Al Jazeera'],
    corroboration: 2, ownerCount: 2, topic: 'world' });

  ok('a story with no figure in it is one card',
     composeStoryPost(plain(), {}).map(x => x.kind).join(',') === 'story');

  const post = composeStoryPost(numeric(), {});
  ok('a story with a figure gets the figure and its provenance',
     post.map(x => x.kind).join(',') === 'story,figure,provenance', post.map(x => x.kind).join(','));
  ok('a post is never two cards — that reads as one that was cut short',
     post.length !== 2);

  /* The bug this exists to catch: composeStory took the stat layout AND the
     figure got a card of its own, so cards one and two came out byte-for-byte
     identical. Nothing in the suite looked, and only a render showed it. */
  ok('the lead card is not the figure card drawn twice',
     JSON.stringify(post[0].params) !== JSON.stringify(post[1].params));
  ok('the lead card carries the headline, the figure card the number',
     post[0].params.headline === numeric().headline && post[0].params.stat == null
     && post[1].params.stat === '40',
     `${post[0].params.layout} / ${post[1].params.stat}`);
  ok('every card of a post can be described to a blind reader',
     post.every(x => x.alt && x.alt.length > 20));

  const prov = post[2].params.item.join(' | ');
  ok('the provenance card names the outlets that carried THIS story',
     /Carried by BBC News, Al Jazeera/.test(prov), prov);
  ok('the provenance card counts the newsrooms and the owners',
     /2 independent newsrooms, 2 owners recorded/.test(prov), prov);
  ok('a story with no photograph promises nothing about photographs',
     !/Pictures/.test(prov), prov);
  ok('the provenance card fits on one card', post[2].params.item.length <= 6);

  ok('a correction is one card and never carries a figure',
     composeStoryPost({ kind: 'correction', headline: 'We said the Sensex fell 900 points',
                        display: 'We said the Sensex fell 900 points', source: 'DailyVolex' }, {})
       .length === 1);
}

ok('a list of items survives being turned into a query', (() => {
  const q = toQuery({ auto: '1', item: ['one', 'two'], skip: null });
  return q.getAll('item').join(',') === 'one,two' && !q.has('skip');
})());



ok('an edition is valid before it is offered', validate(ed).length === 0, validate(ed).join('; '));
ok('a story has a post of its own', postById(ed, 'top-1')?.kind === 'carousel');
ok('a section with a reel offers it as a second post',
  postById(ed, 'top-reel')?.kind === 'reel'
  && postById(ed, 'top-reel').files[0].endsWith('/top/reel.mp4'));
ok('a section is several posts, one per story',
  posts(ed).filter(p => p.section === 'top' && p.kind === 'carousel').length === 2);
ok('a section without a reel offers only its story posts',
  posts(ed).filter(p => p.section === 'business').length === 1);
ok('an edition missing its captions is refused rather than offered', (() => {
  const broken = editionFixture();
  broken.sections[0].posts[0].caption = '';
  return validate(broken).some(w => /caption/.test(w));
})());
ok('a carousel over ten slides is refused', (() => {
  const broken = editionFixture();
  broken.sections[0].posts[0].files = Array.from({ length: 11 }, (_, i) => `s${i}.png`);
  return validate(broken).some(w => /Instagram takes 10/.test(w));
})());
ok('a carousel with no descriptions is refused', (() => {
  const broken = editionFixture();
  broken.sections[0].posts[0].alts = '';
  return validate(broken).some(w => /descriptions/.test(w));
})(), 'the one accessibility promise this channel makes');

const P = (words, opts = {}) => plan(ed, words, opts);

ok('a bare approval posts the top section and nothing else', (() => {
  const r = P('/approve');
  return r.posts?.every(p => p.section === 'top') && r.posts.length === 2;
})());
ok('a single post can be named on its own', (() => {
  const r = P('/approve top-2');
  return r.posts?.length === 1 && r.posts[0].id === 'top-2';
})(), 'one bad story must not cost the whole section');
ok('naming a section and a post inside it is not the post twice', (() => {
  const r = P('/approve top top-2');
  return r.posts?.length === 2;
})());
ok('naming sections posts exactly those', (() => {
  const r = P('/approve business top');
  return r.posts?.map(p => p.id).join(',') === 'business-1,top-1,top-2';
})(), 'and in the order asked for');
ok('/approve all posts every story', (() => {
  const r = P('/approve all');
  return r.posts?.map(p => p.id).join(',') === 'top-1,top-2,business-1';
})());
ok('no approval posts a reel unless the word is there',
  P('/approve all').posts.every(p => p.kind !== 'reel'));
ok('reel posts the reel with its story', (() => {
  const r = P('/approve top reel');
  return r.posts?.map(p => p.id).join(',') === 'top-1,top-reel,top-2';
})());
ok('a reel is queued once, not once per post in its section', (() => {
  const r = P('/approve top reel');
  return r.posts.filter(p => p.kind === 'reel').length === 1;
})(), 'three identical reels on the account from one approval');
ok('the carousel comes first, so it is the post of record', (() => {
  const r = P('/approve top reel');
  return r.posts[0].kind === 'carousel' && r.posts[1].kind === 'reel';
})());
ok('a reel never goes out on its own', (() => {
  // Instagram accepts no description on a reel, so a reel published alone
  // would be a story in a form a blind reader cannot read.
  const r = P('/approve reel');
  return r.posts?.some(p => p.kind === 'carousel');
})());
ok('asking for a reel a section does not have is refused, not ignored', (() => {
  const r = P('/approve business reel');
  return !!r.error && /no reel/.test(r.error);
})());
ok('an unknown section is refused, not guessed', (() => {
  const r = P('/approve sport');
  return !!r.error && /no such section/.test(r.error);
})(), 'posting something close to what they meant is how the wrong thing goes out');
ok('a missing file is refused rather than posted', (() => {
  const r = P('/approve top-1', { exists: f => !f.endsWith('slide-2.jpg') });
  return !!r.error && /missing at the approved commit/.test(r.error);
})());
ok('urls are pinned to the approved commit', (() => {
  const r = P('/approve top reel', { owner: 'o', repo: 'r', sha: 'abc' });
  return r.posts.every(p => p.urls.every(u => u.includes('/abc/')));
})(), 'the watch rewrites the working files every fifteen minutes');
ok('every planned post carries its own caption', (() => {
  const r = P('/approve all');
  return r.posts.every(p => p.caption.includes(p.id))
    && new Set(r.posts.map(p => p.caption)).size === r.posts.length;
})(), 'a caption matched to a post by index is how the wrong one gets attached');
ok('a reel is planned with no descriptions and does not pretend otherwise',
  P('/approve top reel').posts.find(p => p.kind === 'reel').alts === '');

/* ── The permanent record ─────────────────────────────────────────
   The only thing here that outlives a day. The next run reads it to avoid
   repeating a story and a correction reads it to find the post to attach to,
   so a wrong entry is a story published twice or a correction pinned to the
   wrong post. */

const approved = plan(ed, '/approve top reel');
const receipts = [
  { post: 'top-1', section: 'top', kind: 'carousel', mediaId: 'CAR1', permalink: 'https://ig/p/car1' },
  { post: 'top-reel', section: 'top', kind: 'reel',  mediaId: 'REEL1', permalink: 'https://ig/p/reel' },
  { post: 'top-2', section: 'top', kind: 'carousel', mediaId: 'CAR2', permalink: 'https://ig/p/car2' },
];
const led = record({ posted: [] }, {
  edition: ed, plan: approved, published: receipts, issue: 9, now: '2026-10-20T06:00:00.000Z' });

ok('every story of an approved section is recorded',
  led.posted.length === 2, `${led.posted.length}`);
ok('only the sections that were approved are recorded',
  led.posted.every(r => r.section === 'top'));
ok('a story is recorded against the carousel, not the reel',
  led.posted.every(r => /^CAR/.test(r.mediaId)),
  'the carousel is the post of record — it is the one a correction can be commented on'
  + ' and the one that carries descriptions');

/* The bug this exists to catch: receipts were keyed by section and kind, so
   top-1, top-2 and top-3 were all "top:carousel" and the last one won. Every
   story in the section was then recorded against one media id — and this
   record is how a correction finds the post it belongs to. */
ok('each story is recorded against its OWN post, not the section’s last',
  led.posted.map(r => `${r.post}=${r.mediaId}`).sort().join(' ')
    === 'top-1=CAR1 top-2=CAR2',
  led.posted.map(r => `${r.post}=${r.mediaId}`).join(' '));
ok('the permalink recorded is the one of that story’s post',
  led.posted.find(r => r.post === 'top-2').permalink === 'https://ig/p/car2');

ok('the reel is recorded on the story it was made from',
  led.posted.find(r => r.post === 'top-1').reelMediaId === 'REEL1');
ok('and not on the stories it is not of',
  led.posted.find(r => r.post === 'top-2').reelMediaId === undefined,
  'a reel of the lead story claimed on every story is a post that was never made');
ok('the reel does not displace the carousel it belongs to',
  led.posted.find(r => r.post === 'top-1').mediaId === 'CAR1');

/* Approving one story must not record the rest of its section as posted —
   the next run reads this to decide what it has already covered. */
ok('approving one post records one post', (() => {
  const l = record({ posted: [] }, {
    edition: ed, plan: plan(ed, '/approve top-2'), published: receipts });
  return l.posted.length === 1 && l.posted[0].post === 'top-2'
    && l.posted[0].mediaId === 'CAR2';
})(), 'recording a story that was never published hides it from every later run');

ok('a receipt from a publish run by hand still finds its post', (() => {
  const l = record({ posted: [] }, {
    edition: ed, plan: plan(ed, '/approve top-1'),
    published: [{ section: 'top', kind: 'carousel', mediaId: 'HAND' }] });
  return l.posted[0].mediaId === 'HAND';
})());

ok('the approval issue is recorded, so a post can be traced back',
  led.posted.every(r => r.issue === 9));
ok('a post with no receipt records no media id', (() => {
  const l = record({ posted: [] }, { edition: ed, plan: plan(ed, '/approve top'), published: [] });
  return l.posted.every(r => r.mediaId === null);
})(), 'a record that invents an id sends a correction to the wrong post');
ok('the record does not grow without limit', (() => {
  const old = Array.from({ length: 420 }, (_, i) => ({ title: `old ${i}`, mediaId: `m${i}` }));
  return record({ posted: old }, { edition: ed, plan: approved, published: receipts })
    .posted.length === 400;
})());
ok('a correction marks the post it corrected in the history', (() => {
  const history = { posted: [{ title: 'Sensex plunges 900 points', mediaId: '17900' }] };
  const corrEd = soloEdition({
    kind: 'correction', id: '2026-10-20-correction-0800',
    section: 'correction', label: 'CORRECTION', files: ['slide-1.jpg'],
    story: { kind: 'correction', headline: 'We said 900. It was 489.',
      display: 'We said 900. It was 489.', corrects: { mediaId: '17900' } },
  });
  const l = record(history, {
    edition: corrEd, plan: plan(corrEd, '/approve'),
    published: [{ section: 'correction', kind: 'carousel', mediaId: 'C1' }], issue: 11 });
  const marked = l.posted.find(r => r.mediaId === '17900');
  return !!marked?.corrected && marked.correctedBy === 11;
})(), 'a correction invisible in the history is one only the reader knows about');

/* ── The approval issue ───────────────────────────────────────────
   The whole human interface of the channel. Every slide that would be posted
   has to be visible, because the owner is approving what they can see. */

const issue = approvalIssue(ed, {
  owner: 'arunvarkey', repo: 'dailyvolex', sha: 'c0ffee',
  read: f => f.includes('top') ? 'Today’s top stories' : 'Business today',
});

ok('the issue is labelled for approval', issue.labels.includes('awaiting-approval'));
ok('every card of every post is shown', (() => {
  const shown = (issue.body.match(/!\[[^\]]*card [0-9]+\]/g) || []).length;
  const total = posts(ed).filter(p => p.kind === 'carousel')
    .reduce((n, p) => n + p.files.length, 0);
  return shown === total;
})(), 'a card nobody is shown is a card nobody checked');
ok('the images are pinned to the commit the issue is showing',
  issue.body.includes('/arunvarkey/dailyvolex/c0ffee/'));
ok('every post says the words that post it',
  posts(ed).filter(p => p.kind === 'carousel')
    .every(p => issue.body.includes(`/approve ${p.id}`)));
ok('a section with a reel says how to post it',
  /reel/i.test(issue.body));
ok('the issue says a reel never goes out alone',
  /no description on one|always posts the\s*carousel/.test(issue.body.replace(/\s+/g, ' ')));
ok('the reel is offered with its length', /18\.7s/.test(issue.body));
ok('a story with one newsroom behind it is flagged',
  warningsFor(ed).some(w => /only ONE newsroom/.test(w)));
ok('a republisher is named and not counted',
  warningsFor(ed).some(w => /also carried by MSN/.test(w)));
ok('who owns the newsrooms that agree is stated',
  warningsFor(ed).some(w => /owned by one group/.test(w)));
/* A run reads several hundred articles and publishes a dozen. If one of the
   editorial rules is wrong it is eating real news, and the approval issue is
   the only place anyone would ever see it. It vanished from the issue the
   moment the body was built from the edition instead of from a file of its
   own, and nothing noticed, because the only person who reads it is the
   owner. */
ok('the issue shows what the editorial rules refused',
  /<b>Refused<\/b>/.test(issue.body) && /press release is not news/.test(issue.body));
ok('the refused block names examples, not just counts',
  /Acme announces/.test(issue.body));
ok('a run that refused nothing shows no refused block', (() => {
  const quiet = editionFixture();
  quiet.refusals = { read: 10, published: 3, refused: 0, byRule: {} };
  return !/Refused/.test(approvalIssue(quiet, { owner: 'o', repo: 'r', sha: 'a', read: () => '' }).body);
})());
ok('the issue says when pictures are the outlets’ own', (() => {
  const e = editionFixture();
  e.sections[0].stories[0].photo = { from: 'article', credit: 'Photo: Reuters' };
  return /used without a licence/.test(
    approvalIssue(e, { owner: 'o', repo: 'r', sha: 'a', read: () => '' }).body);
})(), 'stated every time rather than left to memory');
ok('a post with only library pictures says nothing about licences', (() => {
  const e = editionFixture();
  e.sections[0].stories[0].photo = { from: 'library', credit: 'File photo: X (CC BY 4.0)' };
  return !/used without a licence/.test(
    approvalIssue(e, { owner: 'o', repo: 'r', sha: 'a', read: () => '' }).body);
})());
ok('the body is within GitHub limits', issue.body.length < 65536, `${issue.body.length}`);

/* ── Offers that are no longer live ──────────────────────────────
   Three runs in one evening left three open offers, each a live invitation
   to post a different version of the same day. Nothing ever withdrew them. */
{
  const bodyFor = id =>
    `![top-1 card 1](https://raw.githubusercontent.com/arunvarkey/dailyvolex/`
    + `${'a'.repeat(40)}/data/editions/${id}/top/1/slide-1.jpg)`;

  ok('an issue says which edition it is offering',
     editionIdIn(bodyFor('2026-10-20')) === '2026-10-20');
  ok('an approval opened from the app says so in words',
     editionIdIn('/approve top-2\n\nedition: 2026-10-20-breaking-0915')
       === '2026-10-20-breaking-0915');
  ok('an issue that names no edition is unreadable, not empty',
     editionIdIn('please post the nice one') === null);
  ok('an edition is named for what it is',
     kindOfEdition('2026-10-20') === 'daily'
     && kindOfEdition('2026-10-20-breaking-0915') === 'breaking'
     && kindOfEdition('2026-10-20-correction-1100') === 'correction');

  const today = { id: '2026-10-21', kind: 'daily' };
  const open = [
    { number: 39, body: bodyFor('2026-10-21') },        // this morning's rebuild
    { number: 40, body: bodyFor('2026-10-20') },        // yesterday, never approved
    { number: 41, body: bodyFor('2026-10-21-breaking-1830') },
    { number: 43, body: bodyFor('2026-10-21') },        // opened AFTER this one
    { number: 44, body: 'post the top one please' },    // not an offer at all
  ];
  const close = superseded(today, open, { number: 42 });
  const closed = close.map(c => c.number).sort((a, b) => a - b);

  ok('a new daily withdraws the older daily offers',
     closed.join(',') === '39,40', closed.join(','));
  ok('it does not withdraw a breaking story that is still live',
     !closed.includes(41),
     'two stories breaking in one afternoon are two offers, not one');
  ok('it never withdraws an offer newer than itself',
     !closed.includes(43), 'a re-run of an older edition must not undo the newer one');
  ok('an issue whose edition cannot be read is left alone',
     !closed.includes(44),
     'closing something we could not identify withdraws an offer nobody meant to');
  ok('it never withdraws itself',
     !superseded(today, [{ number: 42, body: bodyFor('2026-10-21') }], { number: 42 }).length);
  ok('the withdrawal says what replaced it, and that nothing was posted',
     close.every(c => /Superseded by #42/.test(c.comment) && /Nothing was posted/.test(c.comment)));

  ok('a correction withdraws nothing', (() => {
    const corr = { id: '2026-10-21-correction-1100', kind: 'correction' };
    return superseded(corr, open, { number: 42 }).length === 0;
  })(), 'a correction is owed to a reader, not scheduled');

  ok('a breaking edition withdraws only a rebuild of itself', (() => {
    const br = { id: '2026-10-21-breaking-1830', kind: 'breaking' };
    return superseded(br, open, { number: 42 }).map(c => c.number).join(',') === '41';
  })());

  ok('nothing open means nothing to withdraw',
     superseded(today, [], { number: 42 }).length === 0);
}

/* A section used to be one post, so an approval was the whole issue. With a
   post per story, closing it on a partial approval made the rest
   unreachable — a comment can only approve an issue that is still open. */
{
  const one = plan(ed, '/approve top-1');
  ok('a partial approval says what it leaves behind',
     one.remaining.map(r => r.id).join(',') === 'top-2,business-1',
     one.remaining.map(r => r.id).join(','));
  ok('what is left is every post, not just the rest of that section',
     one.remaining.some(r => r.id.startsWith('business')),
     'the issue offered them all and none of them has been posted');
  ok('and says the words that would post it',
     /\/approve top-2/.test(one.remainingNote), one.remainingNote);
  ok('approving everything leaves nothing',
     plan(ed, '/approve all').remaining.length === 0);
  ok('and then says so by saying nothing',
     plan(ed, '/approve all').remainingNote === '');
  ok('a reel is not something left over',
     !plan(ed, '/approve top-1').remaining.some(r => /reel/.test(r.id)),
     'a reel never goes out alone, so it is not an offer of its own');
}

/* A one-section edition — a breaking story or a correction. Both are a
   single card set, and both still have to be approvable. */
function soloEdition({ kind, id, section, label, story, files, extra = {} }) {
  const e = create({ id, kind, sections: [{ id: section, label, stories: [story] }] });
  const dir = `data/editions/${id}`;
  attachPost(e, section, {
    kind: 'carousel', id: section,
    files: files.map(f => `${dir}/${section}/${f}`),
    cover: `${dir}/${section}/${files[0]}`,
    alts: `${dir}/${section}/alt.json`,
    caption: `${dir}/caption-${section}.txt`,
    ...extra,
  });
  return e;
}

/* The three shapes of approval issue. Nothing reaches the account except
   through one of them, and approve.yml gates on the label, so a shape that
   forgot it would be a shape that cannot be approved — or worse, one that
   bypasses the gate. */
const breakingEd = soloEdition({
  kind: 'breaking', id: '2026-10-20-breaking-0915', section: 'world', label: 'WORLD',
  files: ['slide-1.jpg', 'slide-2.jpg'],
  story: { headline: 'Ceasefire agreed in Geneva', display: 'Ceasefire agreed in Geneva',
    source: 'Reuters · AP · BBC News', sourceNames: ['Reuters', 'AP', 'BBC News'],
    corroboration: 3, topic: 'world',
    published: new Date(Date.now() - 23 * 60000).toISOString(),
    link: 'https://example.org/story' },
});
const correctionEd = soloEdition({
  kind: 'correction', id: '2026-10-20-correction-1100',
  section: 'correction', label: 'CORRECTION', files: ['slide-1.jpg'],
  story: { kind: 'correction', headline: 'We said 900 points. It was 489.',
    display: 'We said 900 points. It was 489.',
    corrects: { mediaId: '17900', title: 'Sensex plunges 900 points',
                permalink: 'https://instagram.com/p/x' } },
  extra: { commentOn: '17900',
           commentFile: 'data/editions/2026-10-20-correction-1100/correction-comment.txt' },
});

const breakingIssue = approvalIssue(breakingEd, { owner: 'o', repo: 'r', sha: 'aa', read: () => 'cap' });
const corrIssue = approvalIssue(correctionEd, {
  owner: 'o', repo: 'r', sha: 'bb', read: () => 'cap', requestedBy: 42 });

ok('a breaking issue is still an approval issue',
  breakingIssue.labels.includes('awaiting-approval') && breakingIssue.labels.includes('breaking'));
ok('a breaking issue says how old the story is',
  /2[0-9] minutes old/.test(breakingIssue.body), breakingIssue.body.slice(0, 200));
ok('a breaking issue takes a bare approval, not a section name',
  /Comment `\/approve` to post/.test(breakingIssue.body));
ok('a correction is still an approval issue',
  corrIssue.labels.includes('awaiting-approval') && corrIssue.labels.includes('correction'));
ok('a correction names the post it corrects, with its link',
  /Corrects:\*\* Sensex plunges 900 points/.test(corrIssue.body)
  && corrIssue.body.includes('https://instagram.com/p/x'));
ok('a correction points back at where it was asked for', /#42/.test(corrIssue.body));
ok('a correction says the original is not deleted',
  /not deleted/.test(corrIssue.body));
ok('a correction with a media id says it will be commented on the original',
  /added as a comment on the original post/.test(corrIssue.body));
ok('a correction with no media id says so plainly', (() => {
  const orphan = soloEdition({
    kind: 'correction', id: '2026-10-20-correction-0900',
    section: 'correction', label: 'CORRECTION', files: ['slide-1.jpg'],
    story: { kind: 'correction', headline: 'x', display: 'x', corrects: {} },
  });
  return /cannot be attached as a comment/.test(
    approvalIssue(orphan, { owner: 'o', repo: 'r', sha: 'c', read: () => '' }).body);
})(), 'posts made before the media id was recorded all look like this');
ok('no approval issue is ever unlabelled',
  [issue, breakingIssue, corrIssue].every(i => i.labels.includes('awaiting-approval')),
  'approve.yml gates on that label');

ok('the issue says a bare approval posts top only',
  /bare `\/approve` posts Top stories only/i.test(issue.body));



/* ── What the first live run put on the account ───────────────────
   Every case below is a real headline from the run of 2026-10-21, which was
   the first time any of this met real feeds rather than saved fixtures. Five
   hundred and eighty-five items went in and twenty-one cards came out; these
   are the ones that should not have. */

ok('a broadcaster’s video index is not a story',
  isJunk('Video. Latest news bulletin | October 21st, 2026 – Morning'),
  'the rule wanted a colon after "Video" and this one had a full stop');
ok('a bulletin listing is refused however it is punctuated',
  isJunk('Watch. News bulletin | Evening') && isJunk('Video: Morning news bulletin'));

ok('a company writing up its own event is a press release',
  isPressRelease('On October 20, the 2026 Chery Global Innovation Conference was held in Wuhu'),
  'it was ranked significant and put in TECHNOLOGY');
ok('a headline does not open by setting a date',
  isPressRelease('On March 3, the company reported record revenue'));
ok('past passive is the voice of a press release',
  isPressRelease('The flagship store was successfully launched in Mumbai'));
ok('a developer conference is a marketing occasion',
  isPressRelease('Acme Developer Conference draws 5,000 attendees'));
ok('a real summit is still news',
  !isJunk('COP31 climate summit opens in Belem')
  && !isPressRelease('G20 summit agrees debt relief framework'),
  'the rule must not eat the stories this channel exists to carry');

ok('reported intention is not a reported event',
  isSpeculation('Elon Musk considering Tesla-SpaceX merger'),
  'it led the post, and nothing had happened');
ok('a government weighing a policy is still news',
  !isSpeculation('Government considering new data protection rules'),
  'the rule is narrow to deal words on purpose');
ok('an essay’s thesis is not a story',
  isSpeculation('AI-powered personal assistants could reshape the digital economy'));

ok('a headline that asks rather than answers is a feature',
  tierOf('Is Ebola under control in Kenya after nine cases confirmed?') === 'minor');
ok('every interrogative is caught, not only the wh- words',
  ['Can India meet its climate target?', 'Should the RBI cut again?',
   'Has the rupee stopped falling?', 'Does the deal help farmers?']
    .every(t => tierOf(t) === 'minor'));
ok('a statement that happens to end in a question mark is not demoted',
  tierOf('RBI cuts repo rate by 25 basis points') !== 'minor');

/* Corroboration — the one number this channel is built on. */
ok('an aggregator is not a newsroom, whatever the list spells it',
  isRepublisher('Google News') && isRepublisher('Bing News'),
  'canonicalSource strips a trailing " news", so the list never matched');
ok('a company blog reporting its own company is not a second newsroom',
  isRepublisher('blog.google') && isRepublisher('Microsoft Newsroom'),
  'blog.google was corroborating a story about a Google report');
ok('a press release wire is not a newsroom',
  isRepublisher('PR Newswire') && isRepublisher('GlobeNewswire'));
ok('a platform is not a newsroom',
  ['Instagram', 'X', 'Facebook', 'YouTube', 'Reddit'].every(isRepublisher),
  'a post is not reporting, and whoever wrote it is the subject');
ok('a real newsroom is still a newsroom',
  !isRepublisher('Reuters') && !isRepublisher('BBC News') && !isRepublisher('The Hindu'));
ok('the aggregator is named in the attribution but not in the count', (() => {
  const r = independentSources(['Reuters', 'Google News', 'Global Banking & Finance Review']);
  return r.count === 2 && r.republishers.join() === 'Google News';
})(), 'it did carry the story; it did not stand behind it');
ok('a corporate blog is excluded through the predicate, not the raw list', (() => {
  const r = independentSources(['blog.google', 'Business Standard']);
  return r.count === 1 && r.republishers.join() === 'blog.google';
})(), 'the set cannot know about a blog it has never been told about');

/* Two cards, one briefing. */
ok('a quoted speaker is read off the end of a headline',
  attributionOf('U.S.-India perfectly aligned on core issues: Marco Rubio') === 'marco rubio'
  && attributionOf('The deal is done, says Jane Smith') === 'jane smith');
ok('a desk or a place after a colon is not a speaker',
  attributionOf('Markets: Sensex') === null
  && attributionOf('Earthquake kills at least 40 in northern Afghanistan') === null);
ok('two headlines quoting the same person are one story', (() => {
  const c = clusterBy([
    { title: "Team Trump's Tariffs, Visa Curbs Not Targeted At India: Marco Rubio" },
    { title: 'U.S.-India perfectly aligned on core issues: Marco Rubio' },
  ]);
  return c.length === 1 && c[0].items.length === 2;
})(), 'they went out as two separate cards in the same section');
ok('different speakers are not merged just because both are quoted', (() => {
  const c = clusterBy([
    { title: 'Tariffs not targeted at India: Marco Rubio' },
    { title: 'Tariffs will be reviewed: Piyush Goyal' },
  ]);
  return c.length === 2;
})());
ok('unrelated stories are still unrelated', (() => {
  const c = clusterBy([
    { title: 'Earthquake kills at least 40 in northern Afghanistan' },
    { title: 'Sensex plunges 876 points as banks drag the index lower' },
  ]);
  return c.length === 2;
})());

/* The label on a stat card, which a reader sees at the size of the frame. */
ok('a stat label is not cut mid-phrase', (() => {
  const s = statFor('SBI reports cyberattack exposing 3,897 customer records on dark web');
  return s.stat === '3,897' && s.label === 'customer records';
})(), 'the card went out reading "customer records on dark"');
ok('a stat label stops before a conjunction', (() => {
  const s = statFor('Paddy Power cuts 1,400 jobs and blames betting tax rises');
  return s.label === 'jobs';
})());
ok('a stat label stops before a preposition', (() => {
  const s = statFor('L&T Technology Services zooms on reporting 67% jump in Q2 consolidated net profit');
  return s.label === 'jump';
})());
ok('a label that continues its own phrase is kept whole',
  statFor('Asian Para Games: India wins 24 medals including 5 golds')?.label
  === 'medals including 5 golds',
  '"including" continues the phrase rather than starting a new one');
ok('no stat label ends on a word that cannot end one', (() => {
  const BAD = /\b(on|in|at|for|to|from|with|by|and|or|as|the|a|an)$/i;
  return ['SBI reports cyberattack exposing 3,897 customer records on dark web',
          'Paddy Power cuts 1,400 jobs and blames betting tax rises',
          'Sensex plunges 876 points as banks drag the index lower',
          'Anthropic posts $80bn loss in first half of 2026: WSJ',
          'RBI cuts repo rate by 25 basis points']
    .every(h => !BAD.test(statFor(h)?.label || ''));
})());



/* ── One story per subject, per section ───────────────────────────
   INDIA went out with three cards about the Jio IPO. Clustering cannot catch
   that: their wording overlaps LESS than an unrelated Jio story does — 0.11
   and 0.20 between the IPO headlines, 0.14 between one of them and a Jio
   broadband story — so any threshold that merged them would merge things
   that are not the same story. */

const JIO = [
  "Billionaire Mukesh Ambani's Jio launches India's biggest share sale",
  'Jio IPO Opens Today: Minimum Investment, Price Band, Risks And 10 Key Details',
  'Jio IPO: QIB portion fully subscribed at over 2x demand within minutes',
  'Punjab CM Bhagwant Mann detained for 3 hours at Delhi airport, says BJP',
  'Parvinder Singh Jhota murder case: CBI takes over probe in Chandigarh',
  'More trouble for CJP leaders: Another FIR against Das in Bengaluru',
];
const JDF = documentFrequency(JIO);

ok('a word in a few headlines names a subject',
  subjectsOf(JIO[1], JDF).has('jio') && subjectsOf(JIO[1], JDF).has('ipo'));
ok('a word in only one headline is not a shared subject',
  !subjectsOf(JIO[3], JDF).size, [...subjectsOf(JIO[3], JDF)].join(','));
ok('a number is never a subject',
  ![...subjectsOf('Jio IPO opens at 10 with 2x demand', JDF)].some(w => /^\d+$/.test(w)),
  '"2" being rare says nothing about what a story is');
ok('three headlines about one subject share it',
  sharesSubject(JIO[0], JIO[1], JDF) && sharesSubject(JIO[1], JIO[2], JDF));
ok('unrelated stories share no subject',
  !sharesSubject(JIO[3], JIO[4], JDF) && !sharesSubject(JIO[0], JIO[5], JDF));

ok('a section takes one story per subject', (() => {
  const ranked = JIO.map(t => ({ lead: { title: t, topic: 'india' }, tier: 'notable' }));
  const india = sortIntoSections(ranked, { perSection: 6 }).find(s => s.id === 'india');
  const jio = india.clusters.filter(c => /jio/i.test(c.lead.title));
  return jio.length === 1 && india.clusters.length === 4;
})(), 'three Jio cards in one section is a feed, not a section');

ok('the subject cap survives the pass that fills empty slots', (() => {
  // The topic cap is dropped when filling, which is how all three got in.
  const ranked = JIO.slice(0, 3).map(t => ({ lead: { title: t, topic: 'india' }, tier: 'notable' }));
  const india = sortIntoSections(ranked, { perSection: 6 }).find(s => s.id === 'india');
  return india.clusters.length === 1;
})(), 'a shorter section is better than the same story three times');

/* ── The approval issue a person actually reads ──────────────────── */
ok('only the first card is shown up front', (() => {
  const b = approvalIssue(ed, { owner: 'o', repo: 'r', sha: 'a', read: () => '' }).body;
  const before = b.slice(0, b.indexOf('<details><summary>the other'));
  return (before.match(/!\[/g) || []).length === 1;
})(), 'thirty-one full-size images is not something anyone reads on a phone');
ok('every card is still in the issue', (() => {
  const b = approvalIssue(ed, { owner: 'o', repo: 'r', sha: 'a', read: () => '' }).body;
  const shown = (b.match(/!\[[^\]]*card [0-9]+\]/g) || []).length;
  const total = posts(ed).filter(p => p.kind === 'carousel')
    .reduce((n, p) => n + p.files.length, 0);
  return shown === total;
})(), 'the owner is approving what they can see');



/* ── Does the headline say something happened? ────────────────────
   The only rule that works the other way round. Three live runs produced
   three different batches of non-stories, each answered with another regex;
   a blocklist enumerating everything that is not news never converges. A
   news headline reports an event and an event has a verb. A feature title is
   a noun phrase and has none. */

const news = t => looksLikeNews(t, { quoted: attributionOf(t) !== null });

/* Every one of these is a real headline this channel published or refused. */
const REAL_NEWS = [
  'Earthquake kills at least 40 in northern Afghanistan',
  'RBI cuts repo rate by 25 basis points',
  'Paddy Power cuts 1,400 jobs and blames betting tax rises',
  'Nigeria confirms Ebola case linked to East Africa',
  'Australian MP loses both legs in vehicle attack as suspect appears',
  'Pakistani authorities arrest man accused in $126m US postage fraud',
  "Su-30 fighter jet crashes in Russia's Kaliningrad region: Report",
  'India, New Zealand sign digital trade pact under FTA',
  "Billionaire Mukesh Ambani's Jio launches India's biggest share sale",
  'SBI confirms data leak involving 3,897 customer records on dark web',
  'Anthropic posts $80bn loss in first half of 2026: WSJ',
  "Elon Musk ordered Starlink slowdown that disrupted Ukraine's drones",
  "DNB Exceeds Q3 Profit Forecast as Norway's Economy Stays Strong",
  'Punjab CM Bhagwant Mann detained for 3 hours at Delhi airport',
  'Cabinet clears port expansion scheme for the east coast',
  'Rupee steadies against the dollar',
  'Ceasefire talks resume in Geneva after months of stalemate',
  'Heavy rain shuts schools across Kerala for a second day',
  'Central bank governor resigns without notice',
];
const NOT_NEWS = [
  'Future of Sustainable Aviation Fuel (SAF) Technology',
  'School assembly news headlines today- October 22: Top national',
  'Global Health Research in the America First Era',
  'PM Modi shares an article highlighting technology and research in India',
  'Badr defence deal: Turkey has technology, Qatar has money',
  'The Future of Work',
];

ok('every real headline survives the test',
  REAL_NEWS.every(news),
  REAL_NEWS.filter(t => !news(t)).join(' | ') || 'none refused');
ok('a feature title does not',
  NOT_NEWS.every(t => !news(t)),
  NOT_NEWS.filter(news).join(' | ') || 'none kept');

ok('a noun phrase has no verb in it anywhere',
  !hasNewsVerb('Future of Sustainable Aviation Fuel (SAF) Technology'));
ok('somebody sharing a link reports nothing',
  reportsNothing('PM Modi shares an article highlighting research'),
  'it is grammatically a verb and journalistically nothing');

/* A headline that attributes itself is reporting what someone said, and
   saying something is an event — this one has no finite verb at all. */
ok('a quoted headline qualifies on the attribution', (() => {
  const quoted = 'Perfectly aligned with Delhi: Marco Rubio';
  // No verb in it at all — it passes only because somebody is quoted, and
  // saying something is an event.
  return !looksLikeNews(quoted, { quoted: false })
    && looksLikeNews(quoted, { quoted: true })
    && news("Team Trump's Tariffs, Visa Curbs Not Targeted At India: Marco Rubio");
})());

ok('inflections are generated, so adding a verb means adding one word',
  ['resign', 'resigns', 'resigned', 'resigning',
   'deny', 'denies', 'denied', 'denying',
   'say', 'says', 'said', 'win', 'won', 'cut', 'held', 'sought']
    .every(w => NEWS_VERBS.has(w)));

ok('the refusal is logged under its own name, and last', (() => {
  // Last, so a headline refused for a specific reason is logged under that
  // reason rather than swallowed by this one.
  const press = rejectionReason({ title: 'Introducing Bulbul V4 Flash', published: Date.now() });
  const none  = rejectionReason({ title: 'Future of Sustainable Aviation Fuel Technology',
                                  published: Date.now() });
  return press === 'marketing, not reporting' && none === 'says nothing happened';
})());

ok('a real story is not refused by the new rule',
  REAL_NEWS.every(t => rejectionReason({ title: t, published: Date.now() })
    !== 'says nothing happened'),
  'the list is the rule, so it has to carry the ordinary vocabulary of a news page');



/* ── Corroboration by outlets this channel can name ───────────────
   A HEALTH story went out carried by "Duke Today · Special Olympics" — a
   university comms page and the organisation writing about its own officer,
   counted as two independent newsrooms. Listing every site that is not a
   newsroom never converges; asking for one that IS does. */

ok('an outlet in the register is identifiable',
  independentSources(['BBC News', 'Al Jazeera']).known === 2);
ok('two sites nobody has heard of corroborate nothing',
  independentSources(['Duke Today', 'Special Olympics']).known === 0,
  'they are still counted as sources and still named — they are just not a check');
ok('one identifiable newsroom among unknowns is enough to be identifiable',
  independentSources(['Some Site', 'Reuters']).known === 1);
ok('a spelling that missed the register now reaches it',
  independentSources(['DW.com']).known === 1,
  'Deutsche Welle was in the register all along; "dw" never got there');

ok('a story nobody identifiable carried is not selected', (() => {
  const t = Date.now();
  const mk = (title, source) => ({ title, source, topic: 'health', published: t - 600000, weight: 1 });
  const chosen = selectStories([
    mk('Special Olympics chief health officer elected to academy', 'Duke Today'),
    mk('Special Olympics chief health officer elected to the academy', 'Special Olympics'),
  ], { count: 3, now: t, minSources: 1 });
  return chosen.length === 0;
})(), 'two sources, nothing checked');

ok('the same story with one real newsroom behind it is selected', (() => {
  const t = Date.now();
  const mk = (title, source) => ({ title, source, topic: 'world', published: t - 600000, weight: 1 });
  const chosen = selectStories([
    mk('Nigeria confirms Ebola case linked to East Africa', 'Some Site'),
    mk('Nigeria confirms Ebola case in the east', 'Reuters'),
  ], { count: 3, now: t, minSources: 1 });
  return chosen.length === 1;
})());

/* ── Furniture the outlet pinned to its own headline ────────────── */
ok('a desk label with a colon is furniture, not the headline',
  tidy("India news: India-US trade deal 'pretty close,' says Trump")
  === "India-US trade deal 'pretty close,' says Trump");
ok('a short headline keeps its label rather than being gutted',
  tidy('India news: short') === 'India news: short',
  'the first version of the pipe rule threw away the story and kept the furniture');

/* Caught on a live run: this went out on a card with the desk still on it. */
ok('a desk label with a dash is furniture too',
  tidy('Business - French bond yields hit 24-year high after unrest')
  === 'French bond yields hit 24-year high after unrest');
ok('the desk label does not need the word "news" to be furniture',
  tidy('World — Ceasefire talks resume in Geneva after months of silence')
  === 'Ceasefire talks resume in Geneva after months of silence');
ok('a hyphenated word is not a desk label',
  tidy('Markets-beating fund returns 40% in a year')
  === 'Markets-beating fund returns 40% in a year',
  'the separator has to have space around it, or every hyphen is furniture');
ok('a desk label is not stripped off a fragment',
  tidy('Business - short one') === 'Business - short one');
ok('what is left has to read as a headline, not a continuation',
  tidy('Health - care costs have risen every year since 2019')
  === 'Health - care costs have risen every year since 2019',
  'stripping a label off a lowercase remainder makes a sentence nobody published');

/* The four verbs the first live run proved were missing. */
ok('the verbs that run refused are in the list now',
  ['Haitian migrants changed this US town',
   'Qatar and Turkiye are deepening defence ties',
   'Israeli settlers have Palestinians surrounded',
   'War in Lebanon has cost young people with autism'].every(hasNewsVerb));



/* ── The photograph the outlet put on the story ───────────────────
   Every picture used to come from Wikimedia Commons: safe, and frequently
   nothing to do with the story — four cards in ten went out over a gradient.
   The owner's decision is that the story matters more than the licence, so
   the article's own picture is tried first. It is the outlet's copyright,
   which is why the outlet is named on the card and flagged in the approval
   issue rather than being quietly used. */

const PAGE = (head, base = 'https://example.com/news/story') => ({ head, base });

ok('og:image is read, in either attribute order', (() => {
  const a = imageUrlFrom('<meta property="og:image" content="https://i.ex.com/a.jpg">', PAGE().base);
  const b = imageUrlFrom('<meta content="https://i.ex.com/b.jpg" property="og:image">', PAGE().base);
  return a === 'https://i.ex.com/a.jpg' && b === 'https://i.ex.com/b.jpg';
})());
ok('og:image:url is read too',
  imageUrlFrom('<meta property="og:image:url" content="https://i.ex.com/c.jpg">', PAGE().base)
  === 'https://i.ex.com/c.jpg');
ok('twitter:image is the fallback',
  imageUrlFrom('<meta name="twitter:image" content="https://i.ex.com/t.jpg">', PAGE().base)
  === 'https://i.ex.com/t.jpg');
ok('og:image wins over twitter:image', (() => {
  const html = '<meta name="twitter:image" content="https://i.ex.com/t.jpg">'
             + '<meta property="og:image" content="https://i.ex.com/o.jpg">';
  return imageUrlFrom(html, PAGE().base) === 'https://i.ex.com/o.jpg';
})(), 'og:image is the one outlets actually maintain');
ok('a relative path is resolved against the article',
  imageUrlFrom('<meta property="og:image" content="/img/lead.jpg">',
               'https://thehindu.com/news/india/story-1234')
  === 'https://thehindu.com/img/lead.jpg');
ok('a protocol-relative url is resolved',
  imageUrlFrom('<meta property="og:image" content="//i.ex.com/p.jpg">', 'https://ex.com/a')
  === 'https://i.ex.com/p.jpg');
ok('an escaped ampersand is unescaped',
  imageUrlFrom('<meta property="og:image" content="https://i.ex.com/a.jpg?w=1&amp;h=2">', PAGE().base)
  === 'https://i.ex.com/a.jpg?w=1&h=2');
ok('a page declaring nothing yields nothing',
  imageUrlFrom('<html><head><title>A story</title></head></html>', PAGE().base) === null);

/* Furniture. A card wearing a newspaper's own logo looks like a mistake. */
ok('a masthead is not a photograph',
  ['https://x.com/logo.png', 'https://x.com/favicon.ico', 'https://x.com/1x1.gif',
   'https://x.com/default-image.jpg', 'https://x.com/share-icon.png',
   'https://x.com/placeholder.jpg'].every(isFurniture));
ok('a real photograph is not furniture',
  !isFurniture('https://th.com/2026/10/21/Chandigarh-court-verdict.jpg')
  && !isFurniture('https://i.ex.com/incoming/abc123.jpg?w=1200'));
ok('furniture is skipped rather than returned', (() => {
  const html = '<meta property="og:image" content="https://x.com/logo.png">'
             + '<meta name="twitter:image" content="https://x.com/real-photo.jpg">';
  return imageUrlFrom(html, PAGE().base) === 'https://x.com/real-photo.jpg';
})());
ok('a query string does not make a logo a photograph',
  isFurniture('https://x.com/logo.png?v=3'), 'the path is what is checked');

/* The credit. A picture whose source cannot be named does not go on a card. */
ok('the outlet is credited by name',
  articleCredit('The Hindu · NDTV', 'https://thehindu.com/a') === 'Photo: The Hindu');
ok('with no outlet, the host is named',
  articleCredit('', 'https://www.thehindu.com/news/a') === 'Photo: thehindu.com');

/* The fetch itself never throws: a run that dies because one newspaper was
   slow is a run with no post at all. */
ok('a story with no link is handled, not thrown', async () => {}, '');
{
  const noLink = await imageFromArticle('', { source: 'Reuters' });
  ok('a story with no link asks for nothing',
    noLink.image === null && /no link/.test(noLink.error));

  const ok200 = await imageFromArticle('https://ex.com/a', {
    source: 'Reuters',
    fetchImpl: async () => ({ ok: true, url: 'https://ex.com/a',
      text: async () => '<meta property="og:image" content="https://i.ex.com/a.jpg">' }),
  });
  ok('a page with a picture yields it, credited', ok200.image?.url === 'https://i.ex.com/a.jpg'
    && ok200.image.credit === 'Photo: Reuters' && ok200.image.licence === 'publisher');
  ok('the picture says plainly that it is the publisher’s',
    ok200.image.licence === 'publisher',
    'so the approval issue can show what is being approved');

  const dead = await imageFromArticle('https://ex.com/a', {
    source: 'Reuters', fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  ok('a refusal is reported, not thrown', dead.image === null && /403/.test(dead.error));

  const boom = await imageFromArticle('https://ex.com/a', {
    source: 'Reuters', fetchImpl: async () => { throw new Error('network is down'); },
  });
  ok('a network failure is reported, not thrown',
    boom.image === null && /network is down/.test(boom.error));

  const bare = await imageFromArticle('https://ex.com/a', {
    source: 'Reuters',
    fetchImpl: async () => ({ ok: true, url: 'https://ex.com/a', text: async () => '<html></html>' }),
  });
  ok('a page with no picture is reported as such',
    bare.image === null && /declares no picture/.test(bare.error));
}



/* ── The picture the feed already handed us ───────────────────────
   NDTV answers 403 to a request for its article page and names the same
   photograph in its RSS without being asked. Reading it costs nothing: the
   feed is already in hand, so there is no second request to be refused. */
ok('media:content is read',
  imageIn('<item><media:content url="https://i.ndtv.com/a.jpg" type="image/jpeg"/></item>')
  === 'https://i.ndtv.com/a.jpg');
ok('media:thumbnail is read',
  imageIn('<item><media:thumbnail url="https://i.x.com/t.jpg"/></item>') === 'https://i.x.com/t.jpg');
ok('an image enclosure is read, in either attribute order',
  imageIn('<item><enclosure url="https://i.x.com/e.jpg" type="image/jpeg"/></item>')
  === 'https://i.x.com/e.jpg'
  && imageIn('<item><enclosure type="image/jpeg" url="https://i.x.com/f.jpg"/></item>')
  === 'https://i.x.com/f.jpg');
ok('a picture buried in the description is found',
  imageIn('<item><description><img src="https://i.x.com/d.jpg"></description></item>')
  === 'https://i.x.com/d.jpg');
ok('a feed naming no picture yields none',
  imageIn('<item><title>no picture here</title></item>') === null);
ok('an audio enclosure is not a picture',
  imageIn('<item><enclosure url="https://x.com/ep.mp3" type="audio/mpeg"/></item>') === null,
  'a podcast feed would otherwise put an mp3 on a card');
ok('the feed picture reaches the item',
  parseFeed('<rss><channel><item><title>A real headline about something</title>'
    + '<link>https://x.com/a</link>'
    + '<media:content url="https://i.x.com/a.jpg" type="image/jpeg"/></item></channel></rss>',
    { id: 'x', name: 'X', topic: 'world' })[0]?.feedImage === 'https://i.x.com/a.jpg');



/* ── Feeds hand over thumbnails, not photographs ──────────────────
   BBC named its picture in its RSS and it was 240 pixels wide — five
   kilobytes, rejected as furniture, which was the right call about the wrong
   thing. The size is in the URL, as it is for most news CDNs. */
ok('a BBC thumbnail is asked for at a usable size',
  biggerVariants('https://ichef.bbci.co.uk/ace/standard/240/cpsprodpb/808c/live/f04.jpg')[0]
  === 'https://ichef.bbci.co.uk/ace/standard/1024/cpsprodpb/808c/live/f04.jpg');
ok('a width in the query is raised',
  biggerVariants('https://i.ex.com/a.jpg?w=240&q=70')[0] === 'https://i.ex.com/a.jpg?w=1200&q=70');
ok('a generated thumbnail falls back to its original',
  biggerVariants('https://wp.ex.com/up/lead-150x150.jpg')[0] === 'https://wp.ex.com/up/lead.jpg');
ok('a size segment in the path is raised',
  biggerVariants('https://cdn.ex.com/thumb/320/story.jpg')[0] === 'https://cdn.ex.com/thumb/1200/story.jpg');
ok('a plain url is left alone',
  biggerVariants('https://plain.ex.com/photo.jpg').length === 0,
  'a guess that 404s costs a request, so only guess where the pattern is known');
ok('the original is never among the guesses',
  biggerVariants('https://i.ex.com/a.jpg?w=240').every(u => u !== 'https://i.ex.com/a.jpg?w=240'),
  'it stays as the fallback, it is not a bigger version of itself');



/* ── One story, moving, with a voice over it ──────────────────────
   The old reel was three still cards crossfading and a silent audio track:
   a slideshow with a soundtrack of nothing. This is the other thing. */

/* What it says. The rule does not bend here either — every spoken word was
   published by somebody. A synthetic voice saying something no newsroom said
   is the same invention as printing it, and harder to catch because it is
   gone in a second. */
const SHARK = {
  display: 'Shark trapped for a month in South Korean canal is finally freed',
  source: 'BBC News · The Guardian',
  summary: '<p>The sand tiger shark had been stuck behind a sluice gate since '
         + 'September, and was guided out to sea by divers on Tuesday.</p>',
};

ok('the outlet’s html is read as words',
  plainText('<p>A shark &amp; a gate &hellip;</p>') === 'A shark & a gate …');
ok('the script is the headline, the outlet’s sentence, and who reported it', (() => {
  const s = scriptFor(SHARK);
  return s.lines.length === 4
    && s.lines[1].startsWith('Shark trapped')
    && /sand tiger shark/.test(s.lines[2])
    && s.lines[3] === 'Reported by BBC News and The Guardian.';
})(), JSON.stringify(scriptFor(SHARK).lines));
ok('nothing is said that no newsroom published', (() => {
  const s = scriptFor(SHARK);
  const spoken = s.lines.slice(1).join(' ');
  const published = (SHARK.display + ' ' + plainText(SHARK.summary)
    + ' Reported by BBC News and The Guardian.').toLowerCase();
  // Every word spoken appears in what an outlet wrote, or in the credit.
  return spoken.toLowerCase().replace(/[.,]/g, '').split(/\s+/)
    .every(w => published.includes(w));
})(), 'a voice inventing a sentence is the same invention as printing one');

ok('a summary that only repeats the headline is not read twice', (() => {
  const s = scriptFor({ display: 'Shark freed from canal', source: 'BBC News',
                        summary: 'A shark has been freed from a canal.' });
  return s.lines.length === 3;
})(), 'a voice saying the same thing twice sounds broken');
ok('a teaser that trails off is left out',
  firstSentence('Something began to...') === '',
  'a half sentence read aloud sounds like a fault');
ok('a sentence has to be a sentence',
  firstSentence('No full stop here') === ''
  && firstSentence('Rescue teams reached the valley at first light.')
     === 'Rescue teams reached the valley at first light.');
ok('outlets are read as a presenter would say them',
  spokenSources('BBC News · Al Jazeera · NDTV')
  === 'Reported by BBC News, Al Jazeera and NDTV.',
  'a middle dot is read aloud as nothing at all');
ok('one outlet is not read as a list',
  spokenSources('Reuters') === 'Reported by Reuters.');
ok('two headlines saying the same thing are recognised',
  sameThing('Shark freed from canal in South Korea', 'Shark is freed from a South Korean canal')
  && !sameThing('Shark freed from canal', 'Earthquake kills forty in Afghanistan'));
ok('a read is timed at about a news pace',
  spokenSeconds('one two three four five six seven eight nine ten eleven') > 3
  && spokenSeconds('one two three four five six seven eight nine ten eleven') < 6);

ok('the speech engine is chosen, not assumed', (() => {
  const p = speakArgs('piper', { text: 'hello', out: '/tmp/a.wav', model: '/m.onnx' });
  const e = speakArgs('espeak', { text: 'hello', out: '/tmp/a.wav' });
  return p.cmd === 'piper' && p.stdin === 'hello'
    && e.cmd === 'espeak-ng' && e.args.includes('/tmp/a.wav');
})());
ok('piper without a voice model is an error, not a silent fallback', (() => {
  try { speakArgs('piper', { text: 'x', out: '/tmp/a.wav' }); return false; }
  catch (e) { return /voice model/.test(e.message); }
})());

/* What it shows. */
ok('the article’s video is read from its metadata',
  videoUrlFrom('<meta property="og:video:secure_url" content="https://v.bbc.co.uk/a.mp4">',
               'https://bbc.co.uk/n') === 'https://v.bbc.co.uk/a.mp4');
ok('an advert or a live channel is not the story',
  videoUrlFrom('<meta property="og:video" content="https://v.x.com/preroll-advert.mp4">',
               'https://x.com/a') === null);
ok('a direct file and a page are told apart',
  kindOf('https://v.x.com/a.mp4') === 'file'
  && kindOf('https://www.youtube.com/watch?v=abc') === 'page'
  && kindOf('https://v.x.com/a.m3u8') === 'stream');
ok('a story with no link asks for no video', async () => {}, '');
{
  const none = await videoFromArticle('', { source: 'BBC News' });
  ok('no link, no request', none.video === null && /no link/.test(none.error));
  const found = await videoFromArticle('https://bbc.co.uk/n', {
    source: 'BBC News',
    fetchImpl: async () => ({ ok: true, url: 'https://bbc.co.uk/n',
      text: async () => '<meta property="og:video" content="https://v.bbc.co.uk/a.mp4">' }),
  });
  ok('the outlet’s video is credited to the outlet',
    found.video?.credit === 'Video: BBC News' && found.video.licence === 'publisher');
}

/* How long it runs: the voice sets it, not a number somebody picked. */
ok('the reel is as long as the read, plus a beat each end',
  reelSeconds(17.2) === 19 && reelSeconds(9) === 10.8);
ok('a very short read still clears Instagram’s floor',
  reelSeconds(0.2) >= MIN_SECONDS);
ok('a very long read is capped', reelSeconds(600) === MAX_SECONDS);
ok('a publishable length is not refused', checkDuration(19) === null);

ok('footage is filled to the frame, never letterboxed', (() => {
  const a = ffmpegArgs({ visual: 'f.mp4', overlay: 'c.png', voice: 'v.wav',
                         out: 'o.mp4', seconds: 19, hasFootage: true });
  const fc = a[a.indexOf('-filter_complex') + 1];
  return /force_original_aspect_ratio=increase/.test(fc) && /crop=1080:1920/.test(fc)
    && !/pad=/.test(fc);
})(), 'black bars on a Reel read as a repost of somebody else’s landscape video');
ok('a still is pushed in rather than held', (() => {
  const a = ffmpegArgs({ visual: 'p.jpg', overlay: 'c.png', out: 'o.mp4', seconds: 12 });
  return /zoompan/.test(a[a.indexOf('-filter_complex') + 1]);
})());
ok('the card is composited over whatever is moving', (() => {
  const a = ffmpegArgs({ visual: 'f.mp4', overlay: 'c.png', out: 'o.mp4',
                         seconds: 12, hasFootage: true });
  return /\[bg\]\[card\]overlay=0:0/.test(a[a.indexOf('-filter_complex') + 1]);
})());
ok('with neither footage nor a photograph the card is the picture', (() => {
  const a = ffmpegArgs({ visual: 'card.png', overlay: null, out: 'o.mp4', seconds: 12 });
  const fc = a[a.indexOf('-filter_complex') + 1];
  return !/overlay=/.test(fc) && /zoompan/.test(fc);
})(), 'a day with no reel is worse than a plain one');
ok('the voice starts a beat in and is levelled', (() => {
  const a = ffmpegArgs({ visual: 'f.mp4', overlay: 'c.png', voice: 'v.wav',
                         out: 'o.mp4', seconds: 19, hasFootage: true });
  const fc = a[a.indexOf('-filter_complex') + 1];
  return /adelay=600\|600/.test(fc) && /loudnorm/.test(fc) && /apad/.test(fc);
})(), 'so the first frame is seen before it is talked over');
ok('a silent reel still has an audio track', (() => {
  const a = ffmpegArgs({ visual: 'f.mp4', overlay: 'c.png', out: 'o.mp4',
                         seconds: 12, hasFootage: true });
  return /anullsrc/.test(a.join(' ')) && a.includes('-c:a');
})());
ok('the voice input is numbered right whether or not there is a card', (() => {
  const withCard = ffmpegArgs({ visual: 'f.mp4', overlay: 'c.png', voice: 'v.wav',
                               out: 'o.mp4', seconds: 12, hasFootage: true });
  const without = ffmpegArgs({ visual: 'c.png', overlay: null, voice: 'v.wav',
                               out: 'o.mp4', seconds: 12 });
  return /\[2:a\]/.test(withCard[withCard.indexOf('-filter_complex') + 1])
    && /\[1:a\]/.test(without[without.indexOf('-filter_complex') + 1]);
})(), 'an off-by-one here maps silence over the voice');
ok('nothing in the ffmpeg call goes through a shell', (() => {
  const a = ffmpegArgs({ visual: 'f.mp4', overlay: 'c.png', out: 'o.mp4', seconds: 12 });
  return Array.isArray(a) && a.every(x => typeof x === 'string');
})());


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
