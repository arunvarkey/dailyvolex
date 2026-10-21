#!/usr/bin/env node
/* Stage 1 — read the feeds, pick the stories, write a shortlist.
 *
 * Posts nothing. Writes an edition — data/editions/<id>/edition.json — which
 * every stage after this one reads. Safe to run as often as you like.
 *
 *   node automation/shortlist.mjs [--count 3] [--fixtures] [--quiet]
 *                                 [--no-record]  measure without using the day up
 *                                 [--breaking] [--min-sources 3] [--max-age 1.5]
 *
 * --breaking is the watch mode: it looks only for a story that several
 * independent newsrooms have carried in the last hour or two, and exits
 * without writing an edition when there is none. That is the normal outcome,
 * and it has to be, or a watch that runs every fifteen minutes becomes a
 * machine for manufacturing urgency.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchFeed, parseFeed } from './lib/rss.mjs';
import { selectStories, selectSections, rankEligible } from './lib/select.mjs';
import { sectionOf } from './lib/sections.mjs';
import { makeHeadline, categoryFor, sourceLine } from './lib/headline.mjs';
import { readJson, writeJson, loadHistory, recordPosted } from './lib/store.mjs';
import { create, save, idFor, dirFor } from './lib/edition.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const HISTORY   = join(ROOT, 'data', 'ledger.json');
/* What has already been put in front of the owner for approval. Without this,
   a watch running every fifteen minutes offers the same story every fifteen
   minutes; the ledger alone cannot help, because a story that was offered and
   not approved was never posted. Entries age out, so a story missed once can
   come back tomorrow rather than being silently buried for good. */
const OFFERED   = join(ROOT, 'data', 'offered.json');
/* What the editorial rules refused this run, and which rule refused it. The
   point is not the count — it is being able to read the titles and catch a
   rule that is wrong. It goes INSIDE the edition: when it lived in a file of
   its own, the approval issue read that file directly, and the moment the
   issue was built from the edition instead the refusals silently vanished
   from it. Something only the owner ever reads is exactly the thing that
   disappears without anyone noticing. */
const SAMPLES_PER_RULE = 8;
const OFFER_TTL_HOURS = 36;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const FLAG = name => process.argv.includes(`--${name}`);

/* Fixtures let the whole pipeline be exercised with no network at all, which
   is how it is tested and how a dry run works on a locked-down machine. */
async function loadFromFixtures(feeds) {
  const items = [];
  for (const feed of feeds) {
    try {
      const xml = await readFile(join(HERE, 'fixtures', `${feed.id}.xml`), 'utf8');
      items.push(...parseFeed(xml, feed));
    } catch { /* a missing fixture is fine */ }
  }

  // Fixtures carry the dates they were written with, so they age out of the
  // 24-hour window and every fixture run silently returns nothing — including
  // in CI, which would have started failing the day after they were made.
  // Re-stamp them relative to now, keeping their order and spacing.
  if (items.length) {
    const newest = Math.max(...items.map(i => i.published || 0));
    const now = Date.now();
    if (newest > 0) {
      const shift = now - newest - 30 * 60000;      // newest item half an hour old
      for (const i of items) if (i.published) i.published += shift;
    }
  }
  return { items, errors: [] };
}

async function loadFromNetwork(feeds) {
  const results = await Promise.all(feeds.map(f => fetchFeed(f)));
  const items = [], errors = [];
  for (const r of results) {
    items.push(...r.items);
    if (r.error) errors.push(`${r.feed.id}: ${r.error}`);
  }
  return { items, errors };
}

async function main() {
  const quiet = FLAG('quiet');
  const log = (...a) => { if (!quiet) console.log(...a); };
  const breaking = FLAG('breaking');
  // Watch mode is one story, and only one that is both very fresh and carried
  // by several independent newsrooms. A lower bar on a fifteen-minute loop is
  // how an account ends up shouting about nothing several times an hour.
  const count = breaking ? 1
    : Math.max(1, Math.min(5, parseInt(arg('count', '3'), 10) || 3));
  // Two independent newsrooms for anything that goes out, three for a
  // breaking alert. One used to be enough, and a $7.3bn packaging merger
  // carried by a single trade publication reached Top stories.
  const minSources = Math.max(1, parseInt(arg('min-sources', breaking ? '3' : '2'), 10) || 2);
  const maxAgeHours = Math.max(0.25, parseFloat(arg('max-age', breaking ? '2' : '24')) || 24);

  const { feeds } = await readJson(join(HERE, 'feeds.json'), { feeds: [] });
  if (!feeds.length) throw new Error('no feeds configured');

  const { items, errors } = FLAG('fixtures')
    ? await loadFromFixtures(feeds)
    : await loadFromNetwork(feeds);

  log(`read ${items.length} items from ${feeds.length} feeds`);
  for (const e of errors) log(`  ! ${e}`);

  if (!items.length) {
    // Every feed failing is a real condition worth surfacing, not an empty day.
    throw new Error(`no items from any feed${errors.length ? ': ' + errors.join('; ') : ''}`);
  }

  // Everything already posted, plus everything already put up for approval in
  // the last day and a half.
  const cutoff = Date.now() - OFFER_TTL_HOURS * 3600000;
  const offered = (await loadHistory(OFFERED))
    .filter(o => !o.offeredAt || Date.parse(o.offeredAt) >= cutoff);
  const history = [...await loadHistory(HISTORY), ...offered];

  // Sections are the default shape now: Top stories, then India, World,
  // Business, Technology. Watch mode stays a single story — a breaking alert
  // sorted into a section is not a breaking alert.
  const sectioned = !breaking && !FLAG('no-sections');
  // Six, not three. A section post was a cover plus three cards — four
  // slides, and people swipe for about as long as there is something to
  // swipe to. Meta's API takes ten items in a carousel, so six stories plus
  // a cover and a closing card is eight and leaves room.
  const perSection = Math.max(1, Math.min(8, parseInt(arg('per-section', '6'), 10) || 6));

  // What the editorial rules threw away, and which rule threw it. A run reads
  // several hundred articles and publishes a dozen; without this, a regex
  // quietly eating real news leaves no trace anywhere.
  const rejected = [];

  const sections = sectioned
    ? selectSections(items, { history, count, perSection, minSources, maxAgeHours, rejected })
    : null;
  const chosen = sections
    ? sections.find(s => s.id === 'top').clusters
    : (() => {
        rankEligible(items, { now: Date.now(), maxAgeHours, rejected });
        return selectStories(items, { history, count, minSources, maxAgeHours });
      })();

  if (breaking && !chosen.length) {
    // The ordinary result. Say so plainly and leave the shortlist alone, so
    // nothing downstream mistakes "nothing broke" for "the run failed".
    log('nothing meets the breaking bar'
      + ` (needs ${minSources} independent newsrooms within ${maxAgeHours}h)`);
    console.log('::notice::no breaking story');
    process.exit(0);
  }

  const toStory = c => {
    const h = makeHeadline(c.lead.title);
    return {
      headline: h.headline,
      display: h.display,
      original: c.lead.title,
      truncated: h.truncated,
      usable: h.usable,
      category: categoryFor(c.lead.topic, c.lead.title),
      source: sourceLine(c.sourceNames),
      sourceNames: c.sourceNames,
      corroboration: c.sources,
      // Named, but not counted: sites that carried the story rather than
      // reporting it. Hiding them would overstate the attribution; counting
      // them would overstate the corroboration.
      republishers: c.republishers || [],
      // Ownership of the newsrooms behind the story. Stated as fact, never as
      // a verdict: a state broadcaster can be excellent and a reader-funded
      // site careless. It is here so that agreement between outlets with one
      // owner, or one government, is visible as what it is.
      owners: c.owners || [],
      ownerCount: c.ownerCount ?? null,
      countries: c.countries || [],
      fundings: c.fundings || [],
      unknownOwners: c.unknownOwners ?? 0,
      concentration: c.concentration || [],
      link: c.lead.link,
      // The outlet's own opening sentence. The reel's voiceover reads it,
      // and it is the only source of words beyond the headline that this
      // channel is allowed to speak — everything said out loud was published
      // by somebody.
      summary: c.lead.summary || null,
      // The picture the feed itself named, carried through so the renderer
      // does not have to fetch a page that may refuse it.
      feedImage: c.lead.feedImage || null,
      /* Every outlet in the cluster, not only the one whose wording won.
         A story carried by Reuters and by Google News can end up led by the
         Google item, whose link is a redirect to an interstitial with no
         picture in it — so the Reuters link, which has one, was never tried.
         Deduplicated and capped, because this is a list of things to fetch. */
      sources: [...new Map((c.items || [])
        .filter(i => i.link)
        .map(i => [i.link, { link: i.link, source: i.source, feedImage: i.feedImage || null }]))
        .values()].slice(0, 4),
      published: c.newest ? new Date(c.newest).toISOString() : null,
      topic: c.lead.topic,
      section: sectionOf(c.lead.topic, c.lead.title),
      // Where this sits in the hierarchy — lead, significant, notable, minor.
      // On the approval issue so the editorial judgement is visible and can
      // be argued with, rather than being a number nobody can see.
      tier: c.tier,
      score: c.score,
    };
  };

  const stories = chosen.map(toStory);

  /* The rejection log. Counts alone would only say the filters are busy; the
     titles are the point, because that is how a rule that is wrong becomes
     visible. A bounded sample per rule keeps it readable and small. */
  const byRule = {};
  for (const r of rejected) {
    const b = byRule[r.reason] || (byRule[r.reason] = { count: 0, samples: [] });
    b.count++;
    if (b.samples.length < SAMPLES_PER_RULE)
      b.samples.push({ title: r.title, source: r.source });
  }
  const publishedCount = sections
    ? sections.reduce((n, s) => n + s.clusters.length, 0)
    : stories.length;

  /* A day on which nothing cleared the bar is a real outcome, not a fault.
   *
   * The editorial rules refuse most of what the feeds carry, and on a thin
   * day — or after a rule is tightened — they can refuse all of it. This
   * used to write an edition with no sections in it, exit 0, and leave the
   * render to die on it one second later with "nothing rendered". The run
   * then looked like a crash and opened a failure issue, which is exactly
   * the opposite of what happened: the filters worked and there was nothing
   * worth publishing.
   *
   * So it says so, writes no edition, and tells the workflow to stop here. */
  const usable = sections
    ? sections.filter(sec => sec.clusters.length).length
    : stories.length;
  if (!usable) {
    log(`\nnothing cleared the bar today: ${items.length} read, `
      + `${rejected.length} refused by the editorial rules, none published.`);
    log('No edition written. This is not a failure — it is the filters doing their job.');
    if (process.env.GITHUB_OUTPUT)
      await (await import('node:fs/promises'))
        .appendFile(process.env.GITHUB_OUTPUT, 'empty=yes\n');
    return;
  }

  const edition = create({
    id: idFor({ kind: breaking ? 'breaking' : 'daily' }),
    kind: breaking ? 'breaking' : 'daily',
    pool: items.length,
    feedErrors: errors,
    sections: sections
      ? sections.map(s => ({ id: s.id, label: s.label, stories: s.clusters.map(toStory) }))
      // A breaking story is one story, and it still belongs to a section —
      // it is world news or India news like any other.
      : [{ id: stories[0]?.section || 'top',
           label: stories[0]?.section ? stories[0].section.toUpperCase() : 'TOP STORIES',
           stories }],
    refusals: {
      read: items.length,
      published: publishedCount,
      refused: rejected.length,
      // Read from the feeds, not refused by a rule, but not chosen either:
      // out-ranked, capped, or already seen. Not a concern in the way a
      // refusal is, but the arithmetic should add up.
      consideredNotChosen: Math.max(0, items.length - rejected.length - publishedCount),
      byRule: Object.fromEntries(
        Object.entries(byRule).sort((a, b) => b[1].count - a[1].count)),
    },
  });
  const dir = await save(ROOT, edition);

  // Remember what was offered, so the next run does not offer it again.
  // Never from fixtures: the sample build runs repeatedly, and a second run
  // that suppressed its own fixtures as "already offered" would render
  // nothing and fail CI for a reason that has nothing to do with the code.
  /* --no-record is for measuring, not publishing.
   *
   * Every run remembers what it offered so the next one does not offer it
   * again for 36 hours. That is right for a channel and wrong for testing: I
   * triggered eight runs in an afternoon to measure picture coverage and
   * suppressed twenty-nine stories doing it, until a run found nothing left
   * and the day looked empty when it was only used up. */
  if (!FLAG('fixtures') && !FLAG('no-record')) {
    await recordPosted(OFFERED, stories.map(s => ({
      title: s.display || s.headline, offeredAt: new Date().toISOString(),
    })));
  }

  log(`\nshortlist (${stories.length}):`);
  for (const s of stories) {
    log(`  [${s.tier}] [${s.corroboration} source${s.corroboration > 1 ? 's' : ''}] ${s.headline}`);
    log(`     ${s.source}${s.truncated ? '  (shortened)' : ''}${s.usable ? '' : '  !! too short to use'}`);
    if (s.ownerCount != null) {
      // Say how many outlets have a recorded owner. "2 newsrooms, 1 owner"
      // read as though they shared one, when in fact only one of the two was
      // in the register at all — a different and much weaker statement.
      const unknown = s.unknownOwners || 0;
      log(`     ${s.ownerCount} owner${s.ownerCount === 1 ? '' : 's'} recorded`
        + `${unknown ? ` (${unknown} outlet${unknown === 1 ? '' : 's'} not in the register)` : ''}`
        + `${s.countries.length ? ' · ' + s.countries.join('/') : ''}`
        + `${s.fundings.length ? ' · ' + s.fundings.join(', ') : ''}`);
    }
    for (const w of s.concentration || []) log(`     !! ${w}`);
  }
  log(`\nrefused ${rejected.length} of ${items.length} by the editorial rules:`);
  for (const [rule, b] of Object.entries(byRule).sort((a, b) => b[1].count - a[1].count)) {
    log(`  ${String(b.count).padStart(4)}  ${rule}`);
    // One example each, so an obviously wrong refusal is visible in the log
    // itself rather than only in the file.
    if (b.samples[0]) log(`        e.g. ${b.samples[0].title.slice(0, 72)}`);
  }
  log(`\nedition ${edition.id} written to ${dir}`);
}

main().catch(err => { console.error('shortlist failed:', err.message); process.exit(1); });
