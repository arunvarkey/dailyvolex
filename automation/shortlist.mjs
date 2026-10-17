#!/usr/bin/env node
/* Stage 1 — read the feeds, pick the stories, write a shortlist.
 *
 * Posts nothing. Produces data/shortlist.json, which the render and publish
 * stages read. Safe to run as often as you like.
 *
 *   node automation/shortlist.mjs [--count 3] [--fixtures] [--quiet]
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchFeed, parseFeed } from './lib/rss.mjs';
import { selectStories } from './lib/select.mjs';
import { makeHeadline, categoryFor, sourceLine } from './lib/headline.mjs';
import { readJson, writeJson, loadHistory } from './lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHORTLIST = join(ROOT, 'data', 'shortlist.json');
const HISTORY   = join(ROOT, 'data', 'posted.json');

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
  const count = Math.max(1, Math.min(5, parseInt(arg('count', '3'), 10) || 3));

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

  const history = await loadHistory(HISTORY);
  const chosen = selectStories(items, { history, count });

  const stories = chosen.map(c => {
    const h = makeHeadline(c.lead.title);
    return {
      headline: h.headline,
      display: h.display,
      original: c.lead.title,
      truncated: h.truncated,
      usable: h.usable,
      category: categoryFor(c.lead.topic),
      source: sourceLine(c.sourceNames),
      sourceNames: c.sourceNames,
      corroboration: c.sources,
      link: c.lead.link,
      published: c.newest ? new Date(c.newest).toISOString() : null,
      topic: c.lead.topic,
      score: c.score,
    };
  });

  const payload = {
    generated: new Date().toISOString(),
    pool: items.length,
    feedErrors: errors,
    stories,
  };
  await writeJson(SHORTLIST, payload);

  log(`\nshortlist (${stories.length}):`);
  for (const s of stories) {
    log(`  [${s.corroboration} source${s.corroboration > 1 ? 's' : ''}] ${s.headline}`);
    log(`     ${s.source}${s.truncated ? '  (shortened)' : ''}${s.usable ? '' : '  !! too short to use'}`);
  }
  log(`\nwritten to ${SHORTLIST}`);
}

main().catch(err => { console.error('shortlist failed:', err.message); process.exit(1); });
