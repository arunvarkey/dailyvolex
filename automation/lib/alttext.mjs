/* Describing a card for someone who cannot see it.
 *
 * A news account that publishes images without alt text excludes blind
 * readers from the news. Instagram takes `alt_text` when an image container
 * is created, and we already hold everything needed to write a good one: the
 * category, the headline, who reported it, and what is behind the text.
 *
 * What makes this different from decorative alt text is that the headline IS
 * the content. A sighted reader gets the whole story from the card; so should
 * everyone else. The description therefore leads with the words on the card,
 * not with "an image of".
 *
 * The imagery is described last and briefly. It matters — a photograph is
 * part of what the card communicates, and a reader is entitled to know a
 * library picture is not a photograph of the event — but it is not the story.
 */

const MAX = 1000;          // Instagram's limit for alt_text

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

/* What is behind the headline, in words. */
function backdropPhrase(story) {
  if (story?.photo?.credit) {
    const subject = story.photo.title ? clip(story.photo.title, 70) : null;
    return `Behind the text is a library photograph`
      + (subject ? ` captioned “${subject}”` : '')
      + `, ${story.photo.credit.replace(/^File photo:\s*/i, 'credited to ')}`
      + `. It is not a photograph of this event.`;
  }
  if (story?.kind === 'correction') return 'The background is a plain brand design.';
  // Matches what render.mjs chose; `chart` is the generated market line.
  if (story?.backdrop === 'chart') return 'Behind the text is a generated market chart, not real data.';
  return 'Behind the text is a plain brand design.';
}

/* A single story card. */
export function altForStory(story, { handle = '@dailyvolex' } = {}) {
  if (!story) return '';
  const headline = clip(story.display || story.headline, 320);
  const parts = [];

  parts.push(story.kind === 'correction'
    ? `A correction card from ${handle}.`
    : `A news card from ${handle}${story.category ? `, headed ${story.category}` : ''}.`);

  parts.push(`It reads: “${headline}”.`);

  if (story.source) {
    const n = story.corroboration;
    parts.push(`Reported by ${clip(story.source, 120)}`
      + (n ? ` — ${n} independent newsroom${n > 1 ? 's' : ''}.` : '.'));
  }

  parts.push(backdropPhrase(story));
  return clip(parts.join(' '), MAX);
}

/* The cover of a carousel: the list of what is inside. */
export function altForCover(entry, { handle = '@dailyvolex' } = {}) {
  const stories = entry?.stories || [];
  const label = entry?.sectionLabel || 'Top stories';
  const heads = stories.map(s => clip(s.display || s.headline, 150));

  // The cover's whole job is to list the headlines, so the description does
  // the same rather than saying "a cover image".
  const lead = `The cover card of a ${handle} post headed ${label},`
    + ` listing ${heads.length} ${heads.length === 1 ? 'headline' : 'headlines'}:`;
  return clip([lead, heads.map((h, i) => `${i + 1}. ${h}`).join(' ')].join(' '), MAX);
}

/* Alt text for every slide of a rendered entry, in slide order. */
export function altForEntry(entry, opts = {}) {
  if (!entry) return [];
  const stories = entry.stories || [entry];
  const slides = entry.images || (entry.image ? [entry.image] : []);
  if (!slides.length) return [];

  // A carousel is a cover followed by one card per story; a single card has
  // no cover. Tying this to the slide count rather than to `kind` keeps it
  // right for the breaking watch and for corrections too.
  if (slides.length === stories.length) return stories.map(s => altForStory(s, opts));
  return [altForCover(entry, opts), ...stories.map(s => altForStory(s, opts))]
    .slice(0, slides.length);
}
