/* What each card says, and what it looks like — decided in one pure place.
 *
 * These choices were buried inside render.mjs's URL builder, mixed in with a
 * headless Chrome and a local HTTP server, which meant the only way to ask
 * "does this headline get the stat layout, and what will the blind reader be
 * told?" was to render it and look. They are decisions, not drawing: the
 * layout, the figure, the backdrop and the description are all functions of
 * the story.
 *
 * Pure. No network, no disk, no clock. A card spec goes in one end and the
 * renderer turns it into pixels; nothing here knows how.
 *
 * It mutates the story it is given — `layout`, `stat`, `backdrop` and `alt`
 * are recorded on it — because those choices belong to the edition. The
 * approval issue has to be able to say what is behind a headline, and the
 * description has to match what was actually drawn. Before this, alt text
 * called every card "a plain brand design" because nothing wrote the choice
 * down.
 */

import { backdropFor } from './imagery.mjs';
import { statFor, prefersStat } from './statcard.mjs';
import { altForStory, altForCover, altForClosing } from './alttext.mjs';

/* What goes behind this card when there is no photograph. */
export function backdropOf(story, opts = {}) {
  // A correction is never illustrated. The first one rendered came out over a
  // market chart, because the text it was correcting said "Sensex" and
  // "points" — a chart behind an apology is decoration, and a chart that
  // looks like the figure we got wrong is worse than decoration.
  if (story.kind === 'correction') return 'editorial';
  // An explicit --bg is an instruction and overrides the per-story choice;
  // the default must not, or every card gets the chart again.
  if (opts.bgExplicit) return opts.bg;
  return backdropFor(story.display || story.headline, story.topic);
}

/* One story card.
 *
 * A headline that is really about a number gets the stat layout: one huge
 * figure, with the headline underneath in full. Every card in a post being
 * the same shape is most of why a long post reads flat.
 *
 * Everything on the card is lifted verbatim — the figure is a substring of
 * the headline and so is the label. Rewriting a headline to fit a layout
 * would be inventing, and this channel only ever removes.
 */
export function composeStory(story, opts = {}) {
  // `noStat` is for callers that show the figure somewhere else — the post
  // that gives it a card of its own, and the reel, which has one card for the
  // whole duration and wants the headline on it.
  const stat = !opts.noStat && prefersStat(story)
    ? statFor(story.display || story.headline) : null;
  story.layout = stat ? 'quote' : (opts.layout || 'breaking');
  story.stat = stat;
  // A photograph covers the whole frame, so the backdrop behind it never
  // shows; without one, the choice of backdrop is part of what the card says.
  story.backdrop = story.photo ? null : backdropOf(story, opts);

  const params = {
    auto: '1',
    layout: story.layout,
    theme: opts.theme,
    ratio: opts.ratio,
    category: story.category,
    // The outlet's own capitalisation. The card decides whether to shout it.
    headline: story.display || story.headline,
    source: story.source,
    ticker: opts.ticker,
    bg: story.backdrop || opts.bg,
  };
  if (stat) {
    params.stat = stat.stat;
    params.statlabel = stat.label;
    // The headline in full, below the figure. The card never shows a number
    // without the sentence that explains it.
    params.context = story.display || story.headline;
  }
  if (opts.posy != null) params.posy = String(opts.posy);
  if (story.photo) { params.img = story.photo.path; params.credit = story.photo.credit; }

  story.alt = altForStory(story);
  return { kind: 'story', story, params, alt: story.alt };
}

/* The cover: one card carrying every headline — the classic daily-roundup
   format, and a better fit than a single Breaking card when there is no video
   behind it. */
export function composeCover(stories, opts = {}) {
  const params = {
    auto: '1', layout: 'stories', theme: opts.theme, ratio: opts.ratio,
    label: opts.label, date: opts.date, ticker: opts.ticker, bg: opts.bg,
    // The outlet's own capitalisation, untouched.
    item: stories.map(s => s.display || s.headline),
  };
  return { kind: 'cover', params,
           alt: altForCover({ stories, sectionLabel: opts.label }) };
}

/* The last slide of every carousel.
 *
 * A post used to stop dead on its final story, which is the moment someone
 * has just given you their whole attention and is deciding whether to follow.
 * It says what the channel does rather than shouting FOLLOW, because what
 * this channel does is the reason to follow it. */
export function composeClosing(opts = {}) {
  const params = {
    auto: '1', layout: 'stories', theme: opts.theme, ratio: opts.ratio,
    label: 'HOW THIS IS MADE', date: opts.date, ticker: opts.ticker, bg: 'editorial',
    item: [
      'Every story carried by two or more independent newsrooms',
      'Outlets named on every card, with who owns them',
      'Pictures are openly licensed and credited',
      'Corrections posted in the open, never deleted',
      `Follow ${opts.handle || '@dailyvolex'}`,
    ],
  };
  return { kind: 'closing', params, alt: altForClosing(opts) };
}

/* Every card of one section's post, in slide order: a cover, a card per
   story, then the closing card. The renderer walks this list and draws it. */
export function composeSection(stories, opts = {}) {
  return [
    composeCover(stories, opts),
    ...stories.map(s => composeStory(s, opts)),
    composeClosing(opts),
  ];
}

/* The card specs for a reel: the same cards, upright. The stories keep the
   layout and backdrop they were already given, so a reel can never show a
   different card from the carousel it belongs to. */
export function composeReel(stories, opts = {}) {
  /* No contents page.
   *
   * The carousel opens on a cover listing every headline, which is what
   * earns the tap: you can see what you are about to swipe through. A reel
   * is not swiped, it is scrolled past, and the opening seconds are the only
   * ones most people see. A list of three headlines held for four and a half
   * seconds is a setup before the payoff, and four and a half seconds is a
   * long time to show somebody a contents page.
   *
   * So the reel opens on the lead story — the actual news, in the editorial
   * order the section already decided. Dropping the cover also takes the
   * whole thing from about nineteen seconds to about fourteen, which is
   * where short video completes best. */
  return composeSection(stories, { ...opts, ratio: '9:16' })
    .filter(spec => spec.kind !== 'cover');
}

/* A spec's parameters as a query string. `item` repeats, which is how the
   cover and closing cards carry a list. */
export function toQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) for (const one of v) q.append(k, one);
    else q.set(k, String(v));
  }
  return q;
}

/* ── One story, one post ──────────────────────────────────────────
 *
 * A section carousel put six unrelated stories behind one cover: you tapped
 * for the first and swiped past five you had not chosen. A post about one
 * thing can be judged on its own, shared on its own, and corrected on its
 * own.
 *
 * One card is the normal case — a headline over a photograph is a complete
 * post. More only when the story has more IN IT: a figure worth showing at
 * the size of the frame, and then the provenance that figure should be read
 * with. Never two, because a second card with no third reads as a post that
 * was cut short.
 */

/* The outlets, the ownership, and what this channel promises — for this
   story rather than in general. It is the same claim the closing card made
   to a whole carousel, made to the story it is actually about. */
export function composeProvenance(story, opts = {}) {
  const names = String(story.source || '').split('·').map(x => x.trim()).filter(Boolean);
  const n = story.corroboration || names.length || 1;

  const items = [
    names.length ? `Carried by ${names.join(', ')}` : 'Carried by the outlets named on the card',
    `${n} independent newsroom${n === 1 ? '' : 's'}`
      + (story.ownerCount ? `, ${story.ownerCount} owner${story.ownerCount === 1 ? '' : 's'} recorded` : ''),
  ];
  // Only what is true of THIS story. A promise about pictures on a card with
  // no picture is a promise about nothing.
  if (story.photo?.credit) items.push(story.photo.credit);
  if (story.concentration?.length) items.push(story.concentration[0]);
  items.push('Corrections posted in the open, never deleted');
  items.push(`Follow ${opts.handle || '@dailyvolex'}`);

  return {
    kind: 'provenance',
    params: {
      auto: '1', layout: 'stories', theme: opts.theme, ratio: opts.ratio,
      label: 'WHO REPORTED THIS', date: opts.date, ticker: opts.ticker, bg: 'editorial',
      item: items.slice(0, 6),
    },
    alt: `A card from ${opts.handle || '@dailyvolex'} listing who reported the story`
       + ` — ${items.join('; ')}.`,
  };
}

/* Is there a figure in this headline worth a card of its own? */
export function figureIn(story) {
  return prefersStat(story) ? statFor(story.display || story.headline) : null;
}

/* The figure, at the size of the frame, with the headline under it. */
export function composeFigure(story, opts = {}) {
  const stat = figureIn(story);
  if (!stat) return null;
  return {
    kind: 'figure',
    params: {
      auto: '1', layout: 'quote', theme: opts.theme, ratio: opts.ratio,
      ticker: opts.ticker, bg: story.backdrop || opts.bg || 'editorial',
      source: story.source,
      stat: stat.stat, statlabel: stat.label,
      context: story.display || story.headline,
    },
    alt: `A card from ${opts.handle || '@dailyvolex'} showing the figure ${stat.stat}`
       + `${stat.label ? ' ' + stat.label : ''} very large, above the headline`
       + ` “${story.display || story.headline}”.`,
  };
}

/* The whole post for one story: one card, or three. */
export function composeStoryPost(story, opts = {}) {
  // Decided before the lead is composed, because the lead has to know. The
  // first version let composeStory take the stat layout AND gave the figure
  // its own card after it, so cards one and two came out pixel-identical and
  // the post read as a glitch. The lead is the headline over the picture; the
  // figure follows it, at the size of the frame.
  const hasFigure = Boolean(figureIn(story));
  const lead = composeStory(story, { ...opts, noStat: hasFigure });
  if (!hasFigure) return [lead];
  return [lead, composeFigure(story, opts), composeProvenance(story, opts)];
}
