#!/usr/bin/env node
/* Build the Instagram caption from the rendered shortlist.
 *
 * Every claim in the caption comes from the headline the outlet published, and
 * the outlets are always named. Nothing is characterised, predicted or
 * editorialised — an automated account that starts interpreting news is one
 * bad inference away from a correction it cannot issue.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readJson, writeJson } from './lib/store.mjs';
import { writeFile } from 'node:fs/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const TAGS = {
  crypto: '#crypto #bitcoin #ethereum #cryptonews #blockchain',
  india:  '#sensex #nifty #indianstockmarket #stockmarketindia #investing',
  world:  '#stockmarket #finance #markets #economy #business',
};
const BASE_TAGS = '#dailyvolex #financenews #marketnews';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

export function buildCaption(entry, { handle = '@dailyvolex' } = {}) {
  const lines = [];

  if (entry.kind === 'digest') {
    lines.push(`Today's top stories`, '');
    for (const s of entry.stories) lines.push(`• ${s.display || s.headline}`);
    lines.push('', `Sources: ${[...new Set(entry.sourceNames)].join(', ')}`);
  } else {
    lines.push(entry.display || entry.headline, '', `Source: ${entry.source}`);
  }

  lines.push('', `Follow ${handle} for daily crypto and finance news.`, '');

  const topics = new Set(
    (entry.stories || [entry]).map(s => s.topic).filter(Boolean)
  );
  const tags = [...topics].map(t => TAGS[t]).filter(Boolean);
  lines.push([BASE_TAGS, ...tags].join(' '));

  return lines.join('\n').slice(0, 2200);
}

async function main() {
  const shortlist = await readJson(join(ROOT, 'data', 'shortlist.json'), null);
  if (!shortlist?.stories?.length) throw new Error('no rendered shortlist');

  const index = Math.max(0, parseInt(arg('index', '0'), 10) || 0);
  const entry = shortlist.stories[index];
  if (!entry) throw new Error(`no entry at index ${index}`);

  const caption = buildCaption(entry);
  const out = join(ROOT, 'data', 'pending', `caption-${index + 1}.txt`);
  await writeFile(out, caption, 'utf8');
  console.log(caption);
  console.log(`\nwritten to ${out}`);
}

if (process.argv[1] && process.argv[1].endsWith('caption.mjs')) {
  main().catch(err => { console.error('caption failed:', err.message); process.exit(1); });
}
