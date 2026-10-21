/* What `/approve` means — the only thing in this repository that decides what
 * reaches the account.
 *
 * This lived inside approve.yml, which meant it could not be run anywhere but
 * GitHub and was tested by evaluating JavaScript out of a YAML file. A bug
 * here does not fail loudly; it posts the wrong thing under the channel's
 * name. So it is a module, it is pure, and it is tested directly.
 *
 * The vocabulary:
 *
 *   /approve                  the top section's carousel, and nothing else
 *   /approve top business     those two carousels
 *   /approve all              every section's carousel
 *   /approve top reel         the top carousel AND the top reel
 *   /approve all reel         every carousel, and a reel wherever there is one
 *
 * Naming nothing posts Top stories only: the conservative reading of an
 * ambiguous approval, and what the command has always meant.
 *
 * `reel` never posts a reel on its own. Instagram does not accept a
 * description on a reel, so a reel that went out without its carousel would
 * be a story published in a form a blind reader cannot read — which is the one
 * accessibility promise this channel makes. Asking for a reel therefore asks
 * for the carousel with it.
 *
 * An unrecognised word is refused rather than guessed at. "Post something
 * close to what they meant" is how the wrong thing gets published.
 */

import { posts as allPosts } from './edition.mjs';

const WORDS = { ALL: 'all', REEL: 'reel' };

/* Decide what an approval comment asks for.
 *
 * Pure. `exists` is injected so the caller can check the files are really
 * there at the approved commit without this needing a disk.
 */
export function plan(edition, comment, {
  owner = null, repo = null, sha = null, exists = () => true,
} = {}) {
  const available = allPosts(edition);
  const carousels = available.filter(p => p.kind === 'carousel');
  if (!carousels.length) return { error: 'this edition has nothing to post' };

  const asked = String(comment || '')
    .replace(/^\s*\/approve/i, '').trim().toLowerCase()
    .split(/[\s,]+/).filter(Boolean);

  const wantsReel = asked.includes(WORDS.REEL);
  const wantsAll  = asked.includes(WORDS.ALL);
  const named     = asked.filter(a => a !== WORDS.REEL && a !== WORDS.ALL);

  /* A word is either a section — which approves every post in it — or a
     single post id like "top-2". A section is now several posts, one per
     story, and naming one of them has to be possible or a single bad story
     costs the whole section. */
  const matches = word => carousels.filter(p => p.id === word || p.section === word);

  // A word this edition does not have is a refusal, not a near-miss. The
  // owner may have meant yesterday's post.
  const unknown = named.filter(n => !matches(n).length);
  if (unknown.length) return {
    error: `no such section or post: ${unknown.join(', ')} — this edition has `
      + [...new Set(carousels.map(p => p.section))].join(', ')
      + ` (${carousels.length} posts: ${carousels.map(p => p.id).join(', ')})`,
  };

  let chosen;
  if (wantsAll)          chosen = carousels;
  // Deduplicated: naming a section and a post inside it is one post, not two.
  else if (named.length) chosen = [...new Set(named.flatMap(matches))];
  else                   chosen = carousels.filter(p => p.section === 'top');

  // An edition with no section called "top" — a correction, or a breaking
  // post — still has to be approvable by a bare /approve.
  if (!chosen.length) chosen = [carousels[0]];

  if (wantsReel) {
    const sections = new Set(chosen.map(p => p.section));
    const reels = available.filter(p => p.kind === 'reel' && sections.has(p.section));
    if (!reels.length) return {
      error: `there is no reel for ${[...sections].join(', ')} in this edition`,
    };
    /* Once per section, not once per post. A section is several posts now,
       and appending the reel to each of them queued the same video three
       times — three identical reels on the account from one approval. */
    const added = new Set();
    chosen = chosen.flatMap(p => {
      const reel = reels.find(r => r.section === p.section && !added.has(r.id));
      if (!reel) return [p];
      added.add(reel.id);
      // After its carousel, so the cards are the post of record and land first.
      return [p, reel];
    });
  }

  const missing = [];
  const out = chosen.map(p => {
    for (const f of [...p.files, p.caption, p.alts, p.commentFile].filter(Boolean))
      if (!exists(f)) missing.push(f);
    return {
      id: p.id,
      kind: p.kind,
      section: p.section,
      /* Named by the story, not the section. Seven posts all labelled "TOP
         STORIES" is a list nobody can read, and this label is what the
         approval comment reports back and what the record keeps. */
      label: (p.story || p.sectionLabel) + (p.kind === 'reel' ? ' (reel)' : ''),
      caption: p.caption,
      alts: p.alts || '',
      commentOn: p.commentOn || '',
      commentFile: p.commentFile || '',
      files: p.files,
      // Pinned to the approved commit. What posts has to be what the issue
      // showed: the breaking watch rewrites the working files every fifteen
      // minutes, so approving an hour-old issue used to publish a different
      // post entirely.
      urls: (owner && repo && sha)
        ? p.files.map(f => `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${f}`)
        : p.files.slice(),
    };
  });

  if (missing.length) return {
    error: `missing at the approved commit: ${[...new Set(missing)].join(', ')}`,
  };

  return { posts: out, asked, labels: out.map(p => p.label).join(', ') };
}
