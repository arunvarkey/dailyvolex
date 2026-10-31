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
    // One story, and the outlets that carried it. Named with commas rather
    // than the middle dots the card uses: a card has a line to fit, a caption
    // does not, and "Reuters · AP · BBC News" reads as one odd masthead.
    const names = [...new Set(
      (entry.sourceNames?.length ? entry.sourceNames
        : String(entry.source || '').split('·')).map(s => String(s).trim()).filter(Boolean)
    )];
    lines.push(entry.display || entry.headline, '');
    if (names.length) lines.push(`${names.length > 1 ? 'Sources' : 'Source'}: ${names.join(', ')}`);
  }

  /* The two things a caption is actually for, after the story itself.
   *
   * "Follow for the day's news" describes a schedule. Somebody who has just
   * read one story is deciding whether there will be more like it, so that
   * is what it says now.
   *
   * The share line is first because a share reaches people who have never
   * seen the account, and a follow only reaches somebody already looking at
   * it. It asks for something specific — send it to one person — rather than
   * "share if you agree", which is the register this channel does not use. */
  lines.push('',
    'Know someone who should see this? Send it to them.',
    `Follow ${handle} for more stories like this — every morning, with the`
      + ' outlets named.',
    '');

  const topics = new Set(
    (entry.stories || [entry]).map(s => s.topic).filter(Boolean)
  );
  const tags = [...topics].map(t => TAGS[t]).filter(Boolean);
  lines.push([BASE_TAGS, ...tags].join(' '));

  return lines.join('\n').slice(0, 2200);
}

/* A caption per post, written beside its slides.
 *
 * Named by the post rather than the section, because a section is no longer
 * one post: it is a post per story. Matching a caption to a post by index
 * was one more place for the wrong caption to end up on the right picture,
 * which is exactly what happened when sections landed and the breaking watch
 * kept reading caption-1.txt. The path is recorded on the post, so nothing
 * reconstructs it from a convention.
 */
function entryFor(section, post) {
  const story = (section.stories || []).find(
    s => (s.display || s.headline) === post.story) || (section.stories || [])[0] || {};
  return {
    kind: story.kind === 'correction' ? 'correction' : 'story',
    section: section.id,
    sectionLabel: section.label,
    ...story,
    sourceNames: story.sourceNames || (story.source ? [story.source] : []),
  };
}

async function main() {
  const edition = await load(ROOT, arg('edition'));
  const only = arg('section');

  for (const section of edition.sections) {
    if (only && section.id !== only) continue;
    for (const post of (section.posts || [])) {
      // The reel carries the caption of the post it belongs to; it is
      // written when that post is.
      if (post.kind !== 'carousel') continue;
      const rel = `${dirFor(edition.id)}/caption-${post.id}.txt`;
      const caption = buildCaption(entryFor(section, post));
      await writeFile(join(ROOT, rel), caption, 'utf8');
      attachPost(edition, section.id, { ...post, caption: rel });
      console.log(`${post.id.padEnd(14)} -> ${rel}`);
    }
    // A reel takes the caption of the story it was made from.
    const reel = (section.posts || []).find(p => p.kind === 'reel');
    if (reel) {
      const lead = (section.posts || []).find(p => p.kind === 'carousel');
      if (lead?.caption) attachPost(edition, section.id, { ...reel, caption: lead.caption });
    }
  }

  await save(ROOT, edition);
}

if (process.argv[1] && process.argv[1].endsWith('caption.mjs')) {
  main().catch(err => { console.error('caption failed:', err.message); process.exit(1); });
}
