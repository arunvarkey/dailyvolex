/* The permanent record of what went out.
 *
 * data/ledger.json is the only thing in this repository that outlives a day.
 * The next run reads it to avoid repeating a story, and a correction reads it
 * to find the media id of the post it has to be attached to — so an entry
 * that is wrong is a story published twice, or a correction pinned to the
 * wrong post.
 *
 * It was forty lines of JavaScript inside a `node -e` string inside a `run:`
 * block inside approve.yml, which is to say it ran for the first time in
 * production every time it changed.
 *
 * Pure. The caller reads and writes the files.
 */

const KEEP = 400;        // plenty to catch repeats, small enough to stay quick

/* Add what an approval actually published to the record.
 *
 * `plan`      what dv.mjs plan decided — posts, in order, with their kinds
 * `published` what publish.mjs got back from Instagram, one per post
 * `edition`   the stories behind each post
 */
export function record(ledger, { edition, plan, published = [], issue = null, now = null }) {
  const at = now || new Date().toISOString();
  const planned = (plan?.posts || []);

  /* What came back from Instagram, keyed by the post it belongs to.
   *
   * Keying on section was a real bug twice over. First the moment reels
   * existed: a carousel and a reel of the same section both carry section
   * "top", so the later one — the reel — won, and every story in the record
   * got the reel's media id. Then again when a section became a post per
   * story: top-1, top-2 and top-3 are all "top:carousel", so two of the three
   * media ids were thrown away and all three stories were recorded against
   * whichever receipt happened to be last. A correction is found through this
   * record, so a wrong id here comments on the wrong post. */
  const byPost = new Map();
  for (const p of published || []) {
    // A publish run by hand from the command line carries no post id.
    byPost.set(`${p.section || 'post'}:${p.kind}`, p);
    if (p.post) byPost.set(p.post, p);
  }
  const receipt = p => byPost.get(p.id) || byPost.get(`${p.section || 'post'}:${p.kind}`) || {};

  const sectionsById = new Map((edition?.sections || []).map(s => [s.id, s]));

  /* One row per post, which is one row per story. Walked from the plan rather
     than from the edition: approving top-2 publishes one story, and recording
     the whole section would claim two stories were posted that were not — and
     the next run reads this to decide what it has already covered. */
  const items = [];
  for (const [i, p] of planned.entries()) {
    if (p.kind === 'reel') continue;          // recorded on the post it follows
    const section = sectionsById.get(p.section) || {};
    // The post was named with its story's headline; that is the link back.
    const story = (section.stories || []).find(s => (s.display || s.headline) === p.label)
      || (section.stories || [])[0] || {};
    const post = receipt(p);
    // plan.mjs emits a section's reel directly after the post it was made
    // from, so that pairing is the one to record.
    const next = planned[i + 1];
    const reel = next?.kind === 'reel' && next.section === p.section ? receipt(next) : null;

    items.push({
      title: story.original || story.headline || p.label,
      link: story.link || null,
      section: p.section || null,
      post: p.id || null,
      issue: issue == null ? null : Number(issue),
      mediaId: post.mediaId || null,
      permalink: post.permalink || null,
      // Recorded separately rather than in place of the carousel's, so the
      // reel is in the history without displacing the post of record.
      ...(reel ? { reelMediaId: reel.mediaId || null,
                   reelPermalink: reel.permalink || null } : {}),
      kind: story.kind || p.kind || null,
      posted: at,
    });
  }

  const posted = Array.isArray(ledger?.posted) ? [...ledger.posted] : [];

  /* Mark the corrected post in the record. A correction that is not visible
     in the history is a correction only the reader knows about, and the
     history is what the next run checks.
     Taken from the post that was published rather than from the first story
     of its section: a correction is its own post now, and reading the section
     would mark whatever happened to be listed first. */
  const corrected = new Set(planned.flatMap(p => {
    const section = sectionsById.get(p.section) || {};
    const story = (section.stories || []).find(s => (s.display || s.headline) === p.label)
      || (section.stories || [])[0];
    const id = story?.corrects?.mediaId;
    return id ? [id] : [];
  }));
  for (const rec of posted)
    if (corrected.has(rec.mediaId)) {
      rec.corrected = at;
      rec.correctedBy = issue == null ? null : Number(issue);
    }

  return {
    ...ledger,
    posted: [...items, ...posted].slice(0, KEEP),
    updated: at,
  };
}
