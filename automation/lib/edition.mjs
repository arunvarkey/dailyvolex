/* The edition — one day's decisions, in one declared shape, in one directory.
 *
 * Everything the channel decided about a day lives here: which sections there
 * are, which stories are in them, and per story the tier, who corroborated it
 * and who owns them, the photograph and its licence, the layout, the figure
 * on a stat card, the backdrop, the description for a blind reader. Plus what
 * was refused and why.
 *
 * It replaces data/shortlist.json. Six stages used to write that one file in
 * turn, nobody had declared what was in it, and two of them could disagree
 * about a field name with nothing to say so until something wrong went out
 * under the channel's name.
 *
 * Each edition gets its own directory — data/editions/2026-10-20/ — and
 * nothing ever writes into a directory that is not today's. The breaking
 * watch runs every fifteen minutes; under the old layout it rewrote
 * data/pending each time, so an approval from an hour ago would have
 * published a different post entirely, and the only thing standing between
 * that and the account was a commit hash parsed out of an issue body. Now
 * there is nothing to overwrite.
 *
 * A POST is the unit that gets published, not a section: a section can offer
 * a carousel and a reel, and they are published separately. So what the owner
 * approves is a list of posts, and plan() works in posts.
 */

import { join } from 'node:path';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { readJson, writeJson } from './store.mjs';

export const EDITIONS = join('data', 'editions');
export const LATEST   = join('data', 'latest.json');
export const POST_KINDS = ['carousel', 'reel'];

/* How many editions to keep in the working tree. The history keeps every
   commit regardless — Instagram has to be able to fetch an approved post from
   the commit it was pinned to — but there is no reason for a fresh checkout
   to carry three months of slides. */
export const KEEP_EDITIONS = 10;

const pad = n => String(n).padStart(2, '0');

/* The id, which is also the directory name.
 *
 * A daily edition is the date. A breaking one carries the time, because the
 * watch can catch two in a day and the second must not land on the first. A
 * correction says so, because a directory listing is something a person reads.
 */
export function idFor({ kind = 'daily', at = new Date(), suffix = '' } = {}) {
  const d = at instanceof Date ? at : new Date(at);
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  const base = kind === 'breaking'   ? `${day}-breaking-${time}`
             : kind === 'correction' ? `${day}-correction-${time}`
             : day;
  return suffix ? `${base}-${suffix}` : base;
}

export const dirFor = id => join(EDITIONS, id);

/* A new edition, holding the editorial decisions and nothing else. The
   stages after this one add posts; none of them rewrites what is here. */
export function create({ id, kind = 'daily', sections, refusals = null,
                         feedErrors = [], pool = 0 }) {
  return {
    id, kind,
    builtAt: new Date().toISOString(),
    pool, feedErrors, refusals,
    sections: sections.map(s => ({
      id: s.id, label: s.label, stories: s.stories, posts: [],
    })),
  };
}

/* Record a post against a section. Called by the render, caption and reel
   stages — the only thing they are allowed to change. */
export function attachPost(edition, sectionId, post) {
  const section = edition.sections.find(s => s.id === sectionId);
  if (!section) throw new Error(`no section "${sectionId}" in edition ${edition.id}`);
  const at = section.posts.findIndex(p => p.id === post.id);
  if (at >= 0) section.posts[at] = { ...section.posts[at], ...post };
  else section.posts.push(post);
  return section;
}

/* An edition is valid or it is not offered. These are the fields something
   downstream would crash on, or — worse — quietly publish wrongly. */
export function validate(edition) {
  const wrong = [];
  const push = (where, what) => wrong.push(`${where}: ${what}`);

  if (!edition || typeof edition !== 'object') return ['not an object'];
  if (!edition.id) push('edition', 'has no id');
  if (!Array.isArray(edition.sections) || !edition.sections.length)
    push('edition', 'has no sections');

  for (const [i, s] of (edition.sections || []).entries()) {
    const at = `section ${s?.id || i}`;
    if (!s?.id) push(at, 'has no id');
    if (!s?.label) push(at, 'has no label');
    if (!Array.isArray(s?.stories) || !s.stories.length) push(at, 'has no stories');
    if (!Array.isArray(s?.posts) || !s.posts.length) push(at, 'offers nothing to post');

    for (const story of (s?.stories || [])) {
      const sat = `${at} "${String(story?.display || story?.headline || '?').slice(0, 30)}"`;
      // The two things that must never be missing, because a card without
      // them is a claim with nobody behind it.
      if (!story?.headline) push(sat, 'has no headline');
      if (!story?.source && story?.kind !== 'correction') push(sat, 'names no outlet');
    }

    for (const p of (s?.posts || [])) {
      const pat = `${at} ${p?.kind || 'post'}`;
      if (!POST_KINDS.includes(p?.kind)) push(pat, `is not one of ${POST_KINDS.join(', ')}`);
      if (!p?.id) push(pat, 'has no id');
      if (!p?.caption) push(pat, 'has no caption file');
      if (p?.kind === 'carousel') {
        if (!p.files?.length) push(pat, 'has no slides');
        if (p.files?.length > 10) push(pat, `has ${p.files.length} slides; Instagram takes 10`);
        // A carousel without descriptions shuts blind readers out of the news,
        // which is the one accessibility promise this channel makes.
        if (!p.alts) push(pat, 'has no descriptions');
      }
      if (p?.kind === 'reel' && (p.files || []).length !== 1)
        push(pat, 'is not exactly one video');
    }
  }
  return wrong;
}

/* Every post in the edition, in the order they would be offered. */
export function posts(edition) {
  return (edition?.sections || []).flatMap(s =>
    (s.posts || []).map(p => ({ ...p, section: s.id, sectionLabel: s.label, stories: s.stories })));
}

export function postById(edition, id) {
  return posts(edition).find(p => p.id === id) || null;
}

/* ── On disk ──────────────────────────────────────────────────── */

export async function save(root, edition) {
  const dir = join(root, dirFor(edition.id));
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, 'edition.json'), edition);
  // A pointer to the current edition, so nothing has to glob a directory and
  // guess which is newest — the phone's Today tab included.
  await writeJson(join(root, LATEST), {
    id: edition.id, dir: dirFor(edition.id), kind: edition.kind, builtAt: edition.builtAt,
  });
  return dir;
}

export async function load(root, id = null) {
  const which = id || (await readJson(join(root, LATEST), null))?.id;
  if (!which) throw new Error('no edition has been built — run the shortlist first');
  const edition = await readJson(join(root, dirFor(which), 'edition.json'), null);
  if (!edition) throw new Error(`no edition at ${dirFor(which)}`);
  return edition;
}

/* Delete all but the most recent editions from the working tree. */
export async function prune(root, keep = KEEP_EDITIONS) {
  let names = [];
  try { names = await readdir(join(root, EDITIONS)); } catch { return []; }
  // The id begins with the date, so sorting the names sorts by age.
  const doomed = names.filter(n => !n.startsWith('.')).sort().reverse().slice(keep);
  for (const n of doomed) await rm(join(root, EDITIONS, n), { recursive: true, force: true });
  return doomed;
}
