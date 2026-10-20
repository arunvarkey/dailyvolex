#!/usr/bin/env node
/* Stage 1 — read the feeds, pick the stories, write a shortlist.
 *
 * Posts nothing. Produces data/shortlist.json, which the render and publish
 * stages read. Safe to run as often as you like.
 *
 *   node automation/shortlist.mjs [--count 3] [--fixtures] [--quiet]
 *                                 [--breaking] [--min-sources 3] [--max-age 1.5]
 *
 * --breaking is the watch mode: it looks only for a story that several
 * independent newsrooms have carried in the last hour or two, and exits
 * without writing a shortlist when there is none. That is the normal outcome,
 * and it has to be, or a watch that runs every fifteen minutes becomes a
 * machine for manufacturing urgency.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchFeed, parseFeed } from './lib/rss.mjs';
import { selectStories, selectSections } from './lib/select.mjs';
import { sectionOf } from './lib/sections.mjs';
import { makeHeadline, categoryFor, sourceLine } from './lib/headline.mjs';
import { readJson, writeJson, loadHistory, recordPosted } from './lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHORTLIST = join(ROOT, 'data', 'shortlist.json');
const HISTORY   = join(ROOT, 'data', 'posted.json');
/* What has already been put in front of the owner for approval. Without this,
   a watch running every fifteen minutes offers the same story every fifteen
   minutes; posted.json alone cannot help, because a story that was offered and
   not approved was never posted. Entries age out, so a story missed once can
   come back tomorrow rather than being silently buried for good. */
const OFFERED   = join(ROOT, 'data', 'offered.json');
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
  const minSources = Math.max(1, parseInt(arg('min-sources', breaking ? '3' : '1'), 10) || 1);
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
  const perSection = Math.max(1, Math.min(5, parseInt(arg('per-section', '3'), 10) || 3));

  const sections = sectioned
    ? selectSections(items, { history, count, perSection, minSources, maxAgeHours })
    : null;
  const chosen = sections
    ? sections.find(s => s.id === 'top').clusters
    : selectStories(items, { history, count, minSources, maxAgeHours });

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
      concentration: c.concentration || [],
      link: c.lead.link,
      published: c.newest ? new Date(c.newest).toISOString() : null,
      topic: c.lead.topic,
      section: sectionOf(c.lead.topic),
      // Where this sits in the hierarchy — lead, significant, notable, minor.
      // On the approval issue so the editorial judgement is visible and can
      // be argued with, rather than being a number nobody can see.
      tier: c.tier,
      score: c.score,
    };
  };

  const stories = chosen.map(toStory);

  const payload = {
    generated: new Date().toISOString(),
    pool: items.length,
    feedErrors: errors,
    breaking,
    // Top stories stay under `stories`, where every later stage already looks
    // for them. Sections are additional, not a replacement — renaming the key
    // would have broken the render, the caption, the approval issue and the
    // phone's Today tab all at once, for no gain.
    stories,
    sections: sections
      ? sections.map(s => ({ id: s.id, label: s.label, stories: s.clusters.map(toStory) }))
      : undefined,
  };
  await writeJson(SHORTLIST, payload);

  // Remember what was offered, so the next run does not offer it again.
  // Never from fixtures: the sample build runs repeatedly, and a second run
  // that suppressed its own fixtures as "already offered" would render
  // nothing and fail CI for a reason that has nothing to do with the code.
  if (!FLAG('fixtures')) {
    await recordPosted(OFFERED, stories.map(s => ({
      title: s.display || s.headline, offeredAt: new Date().toISOString(),
    })));
  }

  log(`\nshortlist (${stories.length}):`);
  for (const s of stories) {
    log(`  [${s.tier}] [${s.corroboration} source${s.corroboration > 1 ? 's' : ''}] ${s.headline}`);
    log(`     ${s.source}${s.truncated ? '  (shortened)' : ''}${s.usable ? '' : '  !! too short to use'}`);
    if (s.ownerCount != null)
      log(`     ${s.ownerCount} owner${s.ownerCount === 1 ? '' : 's'}`
        + `${s.countries.length ? ' · ' + s.countries.join('/') : ''}`
        + `${s.fundings.length ? ' · ' + s.fundings.join(', ') : ''}`);
    for (const w of s.concentration || []) log(`     !! ${w}`);
  }
  log(`\nwritten to ${SHORTLIST}`);
}

main().catch(err => { console.error('shortlist failed:', err.message); process.exit(1); });
