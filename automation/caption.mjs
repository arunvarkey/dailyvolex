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
import { correctionCaption } from './correct.mjs';
import { writeFile } from 'node:fs/promises';
import { load, save, dirFor, attachPost } from './lib/edition.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* Hashtags follow the story, and they also tell anyone browsing what this
   account is. A crypto tag set on a general news post advertised a crypto
   channel; a crypto story that earns its place here is business news and is
   tagged as such. */
const TAGS = {
  crypto:        '#business #finance #markets',
  'markets-india':'#sensex #nifty #indianstockmarket #business',
  'markets-world':'#stockmarket #markets #economy #business',
  business:      '#business #economy #finance #markets',
  india:         '#india #indianews #bharat',
  world:         '#worldnews #globalnews #international',
  tech:          '#tech #technology #ai #innovation',
  science:       '#science #research #discovery',
  health:        '#health #medicine #publichealth',
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

/* A section's caption, written beside its slides.
 *
 * Named by its section rather than by an index: the publish step is told
 * which posts to make by name, and matching that to a number was one more
 * place for the wrong caption to end up on the right picture — which is
 * exactly what happened when sections landed and the breaking watch kept
 * reading caption-1.txt. The path is recorded on the post, so nothing has to
 * reconstruct it from a convention ever again.
 */
function entryFor(section) {
  return {
    kind: 'carousel',
    section: section.id,
    sectionLabel: section.label,
    stories: section.stories,
    sourceNames: [...new Set(section.stories.flatMap(s => s.sourceNames || [s.source]))],
  };
}

async function main() {
  const edition = await load(ROOT, arg('edition'));
  const only = arg('section');

  for (const section of edition.sections) {
    if (only && section.id !== only) continue;
    if (!section.posts?.length) continue;         // nothing rendered for it
    const rel = `${dirFor(edition.id)}/caption-${section.id}.txt`;
    const caption = buildCaption(entryFor(section));
    await writeFile(join(ROOT, rel), caption, 'utf8');

    // Every post of the section carries the same caption: a reel of the top
    // stories is the top stories.
    for (const post of section.posts) attachPost(edition, section.id, { ...post, caption: rel });
    console.log(`${section.label.padEnd(12)} -> ${rel}`);
    if (!FLAG('all') && !only) console.log('\n' + caption);
  }

  await save(ROOT, edition);
}

if (process.argv[1] && process.argv[1].endsWith('caption.mjs')) {
  main().catch(err => { console.error('caption failed:', err.message); process.exit(1); });
}
