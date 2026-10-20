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
  const wanted = new Set((plan?.posts || []).map(p => p.section || 'post'));

  /* What came back from Instagram, keyed by section AND kind.
   *
   * Keying on section alone was a real bug the moment reels existed: a
   * carousel and a reel of the same section both carry section "top", so the
   * later one — the reel — won, and every story in the record got the reel's
   * media id. A correction would then have been attached to the reel, which
   * is not the post of record and cannot carry a description. */
  const byPost = new Map((published || []).map(p => [`${p.section || 'post'}:${p.kind}`, p]));

  const sections = (edition?.sections || []).filter(s => wanted.has(s.id));
  const items = sections.flatMap(section => {
    // The carousel is the post of record: it is the one with a description on
    // every slide, and the one a correction can be commented on.
    const carousel = byPost.get(`${section.id}:carousel`)
      || byPost.get(`${section.id}:image`) || {};
    const reel = byPost.get(`${section.id}:reel`) || null;

    return (section.stories || []).map(story => ({
      title: story.original || story.headline,
      link: story.link || null,
      section: section.id || null,
      issue: issue == null ? null : Number(issue),
      mediaId: carousel.mediaId || null,
      permalink: carousel.permalink || null,
      // Recorded separately rather than in place of the carousel's, so the
      // reel is in the history without displacing the post of record.
      ...(reel ? { reelMediaId: reel.mediaId || null,
                   reelPermalink: reel.permalink || null } : {}),
      kind: story.kind || (section.posts || [])[0]?.kind || null,
      posted: at,
    }));
  });

  const posted = Array.isArray(ledger?.posted) ? [...ledger.posted] : [];

  /* Mark the corrected post in the record. A correction that is not visible
     in the history is a correction only the reader knows about, and the
     history is what the next run checks. */
  for (const section of sections) {
    const id = (section.stories || [])[0]?.corrects?.mediaId;
    if (!id) continue;
    for (const rec of posted)
      if (rec.mediaId === id) { rec.corrected = at; rec.correctedBy = issue == null ? null : Number(issue); }
  }

  return {
    ...ledger,
    posted: [...items, ...posted].slice(0, KEEP),
    updated: at,
  };
}
