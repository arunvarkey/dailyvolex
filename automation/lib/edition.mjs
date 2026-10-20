/* The edition — one day's decisions, in one declared shape.
 *
 * Everything the channel decided about a day lives here: which sections there
 * are, which stories are in them, and per story the tier, who corroborated it
 * and who owns them, the photograph and its licence, the layout, the figure on
 * a stat card, the backdrop, the description for a blind reader. Plus what was
 * refused and why.
 *
 * It replaces data/shortlist.json's role as the thing every stage reads. The
 * difference is that this shape is written down and checked: six stages used
 * to write that file in turn, nobody had declared what was in it, and two of
 * them could disagree about a field name with nothing to say so until
 * something wrong went out under the channel's name.
 *
 * `fromShortlist` converts what the pipeline writes today into an edition, so
 * the stages downstream can be built against this shape before the stages
 * upstream are changed to produce it. When they are, the adapter goes and
 * nothing that reads an edition has to change.
 *
 * A POST is the unit that gets published, not a section. A section can offer
 * a carousel and a reel, and they are published separately — so what the
 * owner approves is a list of posts, and `plan()` works in posts.
 */

/* Every section offers a carousel. Only some offer a reel. */
export const POST_KINDS = ['carousel', 'reel'];

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

/* ── The adapter ────────────────────────────────────────────────
   What render.mjs and caption.mjs write today, read as an edition. */
export function fromShortlist(shortlist, { id = null } = {}) {
  const out = shortlist?.output || [];
  const sections = out.map(entry => {
    const sid = entry.section || 'post';
    const label = entry.sectionLabel
      || (entry.kind === 'correction' ? 'CORRECTION' : 'POST');
    const files = (entry.images || [entry.image]).filter(Boolean);

    const postList = [{
      kind: 'carousel',
      id: sid,
      files,
      cover: entry.image || files[0] || null,
      // caption.mjs names a sectioned caption by its section and an
      // unsectioned one by its index. The breaking watch crashed on every
      // story it ever found because something read the other name.
      caption: entry.section
        ? `data/pending/caption-${entry.section}.txt`
        : 'data/pending/caption-1.txt',
      alts: entry.altFile || '',
      // A correction is attached to the post it corrects, so whoever finds
      // the mistake finds the correction with it.
      commentOn: (entry.stories || [entry])[0]?.corrects?.mediaId || '',
    }];

    if (entry.reel?.file) postList.push({
      kind: 'reel',
      id: `${sid}-reel`,
      files: [entry.reel.file],
      cover: entry.reel.cover || entry.image || null,
      caption: postList[0].caption,
      // Said out loud rather than left to be rediscovered: Instagram takes
      // alt_text on an image container and a reel is not one.
      alts: '',
      seconds: entry.reel.seconds ?? null,
      bytes: entry.reel.bytes ?? null,
    });

    return { id: sid, label, stories: entry.stories || [entry], posts: postList };
  });

  return {
    id: id || (shortlist?.generated || new Date().toISOString()).slice(0, 10),
    kind: out.some(e => e.kind === 'correction') ? 'correction'
        : shortlist?.breaking ? 'breaking' : 'daily',
    builtAt: shortlist?.rendered || shortlist?.generated || new Date().toISOString(),
    sections,
    refusals: shortlist?.refusals || null,
    feedErrors: shortlist?.feedErrors || [],
  };
}
