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
import { correctionCaption } from './correct.mjs';
import { writeFile } from 'node:fs/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const TAGS = {
  crypto:        '#crypto #bitcoin #ethereum #cryptonews #blockchain',
  'markets-india':'#sensex #nifty #indianstockmarket #stockmarketindia #investing',
  'markets-world':'#stockmarket #markets #economy #investing',
  business:      '#business #economy #finance #markets',
  india:         '#india #indianews #bharat',
  world:         '#worldnews #globalnews #international',
  tech:          '#tech #technology #ai #innovation',
};
const BASE_TAGS = '#dailyvolex #news #dailynews #breakingnews';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const FLAG = n => process.argv.includes(`--${n}`);

export function buildCaption(entry, { handle = '@dailyvolex' } = {}) {
  // A correction says what was wrong and what is right, and links the post it
  // corrects. It has its own shape because none of the rest applies: there is
  // no outlet to attribute and no topic hashtags to carry.
  if (entry.kind === 'correction') return correctionCaption(entry, { handle });

  const lines = [];

  // A carousel carries the same several stories as a digest; only the shape of
  // the image differs. Without this it fell through to the single-story branch
  // and the caption read "3 stories" instead of naming them.
  if (entry.kind === 'digest' || entry.kind === 'carousel') {
    // A section post says which section it is. "Today's top stories" over a
    // BUSINESS card claims a prominence those stories were not given — they
    // are the day's business news, which is a different statement.
    const label = entry.sectionLabel;
    lines.push(label && entry.section !== 'top'
      ? label[0] + label.slice(1).toLowerCase() + ' today'
      : `Today's top stories`, '');
    for (const s of entry.stories) lines.push(`• ${s.display || s.headline}`);
    lines.push('', `Sources: ${[...new Set(entry.sourceNames)].join(', ')}`);
  } else {
    lines.push(entry.display || entry.headline, '', `Source: ${entry.source}`);
  }

  lines.push('', `Follow ${handle} for the day's news.`, '');

  const topics = new Set(
    (entry.stories || [entry]).map(s => s.topic).filter(Boolean)
  );
  const tags = [...topics].map(t => TAGS[t]).filter(Boolean);
  lines.push([BASE_TAGS, ...tags].join(' '));

  return lines.join('\n').slice(0, 2200);
}

/* Each post needs its own caption file for the publish step to pick up. A
   sectioned post is named by its section, because the publish step is told
   which sections to post by name and matching that to an index would be one
   more place for the wrong caption to end up on the right picture. */
async function writeCaption(entry, index) {
  const name = entry.section ? `caption-${entry.section}.txt` : `caption-${index + 1}.txt`;
  const file = join(ROOT, 'data', 'pending', name);
  const caption = buildCaption(entry);
  await writeFile(file, caption, 'utf8');
  return { file, caption };
}

async function main() {
  const shortlist = await readJson(join(ROOT, 'data', 'shortlist.json'), null);
  const out = shortlist?.output || shortlist?.stories;
  if (!out?.length) throw new Error('nothing rendered yet — run render.mjs first');

  if (FLAG('all')) {
    for (const [i, entry] of out.entries()) {
      const { file } = await writeCaption(entry, i);
      console.log(`${(entry.sectionLabel || 'POST').padEnd(12)} -> ${file}`);
    }
    return;
  }

  const index = Math.max(0, parseInt(arg('index', '0'), 10) || 0);
  const entry = out[index];
  if (!entry) throw new Error(`no entry at index ${index}`);

  const { file, caption } = await writeCaption(entry, index);
  console.log(caption);
  console.log(`\nwritten to ${file}`);
}

if (process.argv[1] && process.argv[1].endsWith('caption.mjs')) {
  main().catch(err => { console.error('caption failed:', err.message); process.exit(1); });
}
