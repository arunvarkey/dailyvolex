#!/usr/bin/env node
/* Tests for the parts where a bug would put something wrong on the account.
 *   node automation/test.mjs
 */

import { parseFeed } from './lib/rss.mjs';
import { similarity, cluster, selectStories, isRepeat, isTopical, isAdvice,
         isSpeculation, isJunk, rankClusters } from './lib/select.mjs';
import { makeHeadline, tidy, sourceLine, categoryFor } from './lib/headline.mjs';
import { buildCaption } from './caption.mjs';
import { isUsable, pickBest, creditFor, subjectFor, findImage,
         queriesFor, entitiesFrom, isTitleCase, relevance } from './lib/imagery.mjs';

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

// On a quiet day the cap must not leave the post short.
const onlyCrypto = lopsided.slice(0, 3);
ok('the cap still fills the post when there is nothing else',
  selectStories(onlyCrypto, { count: 3, now }).length === 3,
  `${selectStories(onlyCrypto, { count: 3, now }).length} picked`);

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
    === 'Photo: Jane Doe / CC BY 4.0',
  creditFor({ creator:'Jane Doe', license:'by', license_version:'4.0' }));
ok('CC0 credit still names the creator',
  creditFor({ creator:'Jane Doe', license:'cc0' }) === 'Photo: Jane Doe / CC0');
ok('a missing creator does not produce "undefined"',
  !/undefined/.test(creditFor({ license:'cc0' })), creditFor({ license:'cc0' }));

ok('a named institution drives the search',
  subjectFor('Federal Reserve cuts interest rates') === 'federal reserve building',
  subjectFor('Federal Reserve cuts interest rates'));
ok('Sensex maps to an Indian subject',
  /mumbai/.test(subjectFor('Sensex climbs 540 points to a record high')));
ok('there is always a subject',
  subjectFor('Something entirely unexpected happens').length > 0);

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
