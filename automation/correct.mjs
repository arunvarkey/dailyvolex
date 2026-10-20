#!/usr/bin/env node
/* Correcting something already posted.
 *
 * A news account that cannot correct itself is not a news account, it is a
 * broadcast. Everything else here exists to stop a wrong thing going out; this
 * exists for when one did anyway, which eventually it will.
 *
 * What a correction does NOT do is quietly disappear the original. The
 * Instagram API's support for deleting a published post is unsettled, and more
 * to the point deletion is not a correction — people saw it, and a channel
 * that silently removes its mistakes is less trustworthy than one that owns
 * them, not more. So a correction is additive: a new post that states plainly
 * what was wrong and what is right, and a comment on the original pointing at
 * it, so whoever finds the mistake finds the correction with it.
 *
 *   node automation/correct.mjs --text "We said X. In fact Y." [--issue 42]
 *   node automation/correct.mjs --text-file <path> [--issue 42]
 *                               [--media <instagram media id>]
 *
 * Writes data/shortlist.json with a single correction entry, ready for
 * render.mjs and caption.mjs exactly like any other post. It publishes
 * nothing — the approval gate is the same one everything else goes through.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readJson, writeJson } from './lib/store.mjs';
import { makeHeadline } from './lib/headline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHORTLIST = join(ROOT, 'data', 'shortlist.json');
const HISTORY   = join(ROOT, 'data', 'posted.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

/* Which post is being corrected. Named by the approval issue it went out
   from, which is the handle a person actually has; failing that, the most
   recent post, because a correction almost always follows closely. */
export function findOriginal(posted = [], { issue = null, mediaId = null } = {}) {
  const live = posted.filter(p => p.posted || p.postedAt);
  if (mediaId) return live.find(p => p.mediaId === mediaId) || null;
  if (issue != null) {
    const n = Number(issue);
    const match = live.filter(p => Number(p.issue) === n);
    if (match.length) return match[0];
    return null;
  }
  return live[0] || null;
}

/* The caption carries the whole correction; the card carries the part that
   has to be legible at a glance. Neither invents anything — the text is the
   owner's, quoted as written. */
export function buildCorrection(text, original, { now = new Date() } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('a correction needs text — what was wrong, and what is right');

  const h = makeHeadline(clean, { max: 120 });
  const when = original?.posted || original?.postedAt;

  return {
    kind: 'correction',
    category: 'CORRECTION',
    headline: h.headline,
    display: clean,                       // the caption quotes it in full
    original: clean,
    truncated: h.truncated,
    // A correction is always worth posting, however short. The usability rule
    // exists to catch headlines mangled by shortening, not to refuse "We said
    // 900 points. It was 90."
    usable: true,
    source: 'DailyVolex correction',
    sourceNames: ['DailyVolex'],
    corroboration: 1,
    republishers: [],
    topic: 'correction',
    section: 'correction',
    link: original?.permalink || null,
    published: now.toISOString(),
    // What is being corrected, for the caption and for the comment that gets
    // attached to the original post.
    corrects: original ? {
      title: original.title || null,
      mediaId: original.mediaId || null,
      permalink: original.permalink || null,
      issue: original.issue ?? null,
      postedAt: when || null,
    } : null,
  };
}

export function correctionCaption(entry, { handle = '@dailyvolex' } = {}) {
  const lines = ['CORRECTION', ''];
  const c = entry.corrects;
  if (c?.title) lines.push(`On ${(c.postedAt || '').slice(0, 10) || 'a recent post'} we posted:`,
                           `“${c.title}”`, '');
  lines.push(entry.display, '');
  if (c?.permalink) lines.push(`The original post: ${c.permalink}`, '');
  lines.push('We correct mistakes in the open rather than deleting them.', '',
             `Follow ${handle} for the day's news.`, '',
             '#dailyvolex #correction #news');
  return lines.join('\n').slice(0, 2200);
}

async function main() {
  // From a file by preference: the text is written by a person in a GitHub
  // comment, and passing it through a shell is a step it does not need.
  const textFile = arg('text-file');
  const text = textFile ? await readFile(textFile, 'utf8') : arg('text');
  if (!text || !text.trim())
    throw new Error('--text "We said X. In fact Y." or --text-file <path> is required');

  const history = await readJson(HISTORY, { posted: [] });
  const wanted = { issue: arg('issue'), mediaId: arg('media') };
  const original = findOriginal(history.posted || [], wanted);

  // A named original that cannot be found must NOT quietly become "the most
  // recent post" — that would attach the correction to something that was
  // never wrong. Fall back to a standalone correction and say so.
  if (!original && (wanted.issue || wanted.mediaId))
    console.warn(`WARNING: no posted record matches `
      + `${wanted.issue ? `issue #${wanted.issue}` : `media ${wanted.mediaId}`}`
      + ` — issuing a standalone correction that names no original post.`);

  const entry = buildCorrection(text, original);

  // The comment that gets attached to the post being corrected. Written to a
  // file so it never has to survive a shell on its way to the API.
  if (entry.corrects?.mediaId) {
    await mkdir(join(ROOT, 'data', 'pending'), { recursive: true });
    await writeFile(join(ROOT, 'data', 'pending', 'correction-comment.txt'),
      `CORRECTION: ${entry.display}\n\nWe have posted a correction in full.`, 'utf8');
  }

  await writeJson(SHORTLIST, {
    generated: new Date().toISOString(),
    correction: true,
    pool: 0,
    feedErrors: [],
    stories: [entry],
  });

  console.log('CORRECTION');
  console.log(`  ${entry.display}`);
  if (original) {
    console.log(`  corrects: ${original.title || '(untitled)'}`);
    console.log(`  posted:   ${original.posted || original.postedAt || 'unknown'}`
      + (original.permalink ? `  ${original.permalink}` : ''));
    if (!original.mediaId)
      console.log('  NOTE: no Instagram media id on that record, so the correction'
        + ' cannot be attached as a comment to the original post.');
  } else {
    console.log('  NOTE: nothing posted yet, so this corrects no specific post.');
  }
  console.log(`\nwritten to ${SHORTLIST}`);
}

if (process.argv[1] && process.argv[1].endsWith('correct.mjs')) {
  main().catch(err => { console.error('correction failed:', err.message); process.exit(1); });
}
