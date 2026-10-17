#!/usr/bin/env node
/* Tests for the parts where a bug would put something wrong on the account.
 *   node automation/test.mjs
 */

import { parseFeed } from './lib/rss.mjs';
import { similarity, cluster, selectStories, isRepeat, isTopical, rankClusters } from './lib/select.mjs';
import { makeHeadline, tidy, sourceLine, categoryFor } from './lib/headline.mjs';
import { buildCaption } from './caption.mjs';
import { isUsable, pickBest, creditFor, subjectFor, findImage } from './lib/imagery.mjs';

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
ok('off-topic items never reach the shortlist',
  !selectStories([
    { title: 'Claude cracks a 25-year NSA number mystery', source:'A', published: Date.now(), weight:1, topic:'crypto' },
    { title: 'Claude cracks a 25-year NSA number mystery, say researchers', source:'B', published: Date.now(), weight:1, topic:'crypto' },
  ], { count: 3, now: Date.now() }).length);

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
ok('category comes from the topic', categoryFor('india') === 'INDIA MARKETS');

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

// The search itself, with the API stubbed.
const stubOk = async () => ({ ok:true, json: async () => ({ results: [
  img({ license:'by-nc', creator:'No' }),            // must be skipped
  img({ license:'by', creator:'Yes', width:3000 }),
]}) });
const found = await findImage('Bitcoin rallies', { fetchImpl: stubOk });
ok('the search skips unusable licences', found.image?.credit.includes('Yes'), JSON.stringify(found.image));

const stubEmpty = async () => ({ ok:true, json: async () => ({ results: [img({license:'by-nd'})] }) });
ok('nothing usable yields no image, not a bad one',
  (await findImage('x', { fetchImpl: stubEmpty })).image === null);

// The same subject twice must not yield the same photograph twice.
const two = [img({license:'cc0', url:'https://x/a.jpg', width:3000}),
             img({license:'cc0', url:'https://x/b.jpg', width:2000})];
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
