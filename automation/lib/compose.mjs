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
  const stat = prefersStat(story) ? statFor(story.display || story.headline) : null;
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
    headline: story.headline,
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
  return composeSection(stories, { ...opts, ratio: '9:16' });
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
