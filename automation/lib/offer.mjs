/* The approval issue — everything the owner needs to decide, on one screen.
 *
 * This is the whole human interface of the channel, and there are three
 * shapes of it: the daily post, a breaking story the watch caught, and a
 * correction. All three lived inside workflow YAML — about a hundred and
 * fifty lines of JavaScript across three files — which is why none of them
 * could be run on a laptop, and why the one thing they exist to do, show the
 * owner exactly what they are approving, was checked by counting markdown
 * image tags in a test that string-evaluated them out of the workflow.
 *
 * Pure: an edition in, text out. `read` is injected so it needs no disk.
 *
 * Two rules all three keep. Every slide that would be posted is shown,
 * because the owner is approving what they can see and a slide nobody looked
 * at is a slide nobody checked. And every doubt the pipeline had is stated —
 * one newsroom behind a story, newsrooms with a common owner, a missing
 * photograph, a shortened headline — because the pipeline's confidence is not
 * evidence and the owner is the one deciding.
 */

import { posts as allPosts } from './edition.mjs';

const MB = n => `${((n || 0) / 1048576).toFixed(1)} MB`;

/* Everything the run was unsure about, in the owner's words rather than the
   pipeline's. */
export function warningsFor(edition) {
  const out = [];
  for (const s of edition.sections || []) {
    const many = (edition.sections || []).length > 1 || (s.stories || []).length > 1;
    const tag = many ? `${s.label}: ` : '';
    for (const story of s.stories || []) {
      if (story.kind === 'correction') continue;
      const who = `${tag}"${String(story.display || story.headline || '').slice(0, 44)}…"`;
      if ((story.corroboration ?? 0) < 2) out.push(`${who} has only ONE newsroom behind it.`);
      if (story.republishers?.length)
        out.push(`${tag}also carried by ${story.republishers.join(', ')}`
          + ' — not counted as corroboration.');
      for (const c of (story.concentration || [])) out.push(`${tag}${c}`);
      if (story.truncated) out.push(`${who} was shortened to fit the card.`);
      if (story.photoError) out.push(`${tag}no photo — ${story.photoError}`);
    }
  }
  if (edition.feedErrors?.length) out.push(`Feeds that failed: ${edition.feedErrors.join('; ')}`);

  /* Said once, at the top, rather than on every card. The outlets' own
     photographs are used without a licence — a deliberate decision, and one
     the person approving the post should see stated every time rather than
     have to remember. */
  const all = (edition.sections || []).flatMap(s => s.stories || []);
  const fromArticle = all.filter(s => s.photo?.from === 'article').length;
  if (fromArticle) out.push(
    `${fromArticle} of ${all.length} pictures are the outlets' own photographs,`
    + ' used without a licence and credited to them by name.'
    + ' A rights holder can issue a takedown against these.');
  return out;
}

function checkBlock(warnings) {
  return warnings.length ? `\n### ⚠️ Check\n${warnings.map(w => `- ${w}`).join('\n')}` : '';
}

function captionBlock(text, heading = '**Caption**') {
  return [heading, '```', (text || '').trim() || '(no caption)', '```'].join('\n');
}

function storyLine(s) {
  return `- ${s.tier ? `\`${s.tier}\` ` : ''}**${s.display || s.headline}**\n  _${s.source}_ · `
    + `${s.corroboration} independent newsroom${s.corroboration > 1 ? 's' : ''}`
    + (s.ownerCount ? `, ${s.ownerCount} owner${s.ownerCount > 1 ? 's' : ''} recorded` : '')
    + (s.unknownOwners ? ` (${s.unknownOwners} not in the register)` : '')
    + (s.countries?.length ? ` (${s.countries.join('/')})` : '')
    + (s.truncated ? ' · shortened to fit' : '')
    + (s.link ? `\n  ${s.link}` : '');
}

function refusedBlock(refusals) {
  const rules = Object.entries(refusals?.byRule || {});
  if (!rules.length) return '';
  // A run reads several hundred articles and publishes a dozen. If one of
  // those rules is wrong it is eating real news, and this is the only place
  // anyone would ever see it.
  return [
    '<details>',
    `<summary><b>Refused</b> — ${refusals.refused} of ${refusals.read} read`
      + `, ${refusals.published} published.`
      + ' Check these for anything that should have run.</summary>',
    '',
    ...rules.map(([rule, b]) => [
      `**${b.count} · ${rule}**`,
      ...(b.samples || []).map(s => `- ${s.title}${s.source ? ` _(${s.source})_` : ''}`),
      '',
    ].join('\n')),
    '</details>',
  ].join('\n');
}

const join = lines => lines.filter(x => x !== '' && x != null).join('\n');

/* ── The daily post ───────────────────────────────────────────── */
function dailyIssue(edition, { raw, read }) {
  const sections = edition.sections || [];
  const reels = allPosts(edition).filter(p => p.kind === 'reel');

  /* A block per POST, not per section. A section is no longer one post: it
     is a post per story, and the owner approves posts. */
  const blocks = sections.flatMap(section =>
    (section.posts || []).filter(p => p.kind === 'carousel').map(post => {
      const reel = (section.posts || []).find(
        p => p.kind === 'reel' && p.id.startsWith(post.id.split('-')[0]));
      const slides = post.files || [];
      const story = (section.stories || []).find(
        st => (st.display || st.headline) === post.story) || {};

      return join([
        `<details${post.id.endsWith('-1') && section.id === 'top' ? ' open' : ''}>`,
        `<summary><b>${section.label}</b> — ${post.story || '(untitled)'}`
          + ` · ${slides.length} card${slides.length === 1 ? '' : 's'}`
          + ` · post with <code>/approve ${post.id}</code></summary>`,
        '',
        slides.length ? `![${post.id} card 1](${raw(slides[0])})` : '',
        slides.length > 1 ? [
          '',
          `<details><summary>the other ${slides.length - 1} card${slides.length > 2 ? 's' : ''}</summary>`,
          '',
          slides.slice(1).map((p, i) => `![${post.id} card ${i + 2}](${raw(p)})`).join('\n'),
          '',
          '</details>',
        ].join('\n') : '',
        '',
        reel && post.id.endsWith('-1')
          ? `🎬 **Reel** — ${reel.seconds ?? '?'}s`
            + (reel.bytes ? `, ${MB(reel.bytes)}` : '')
            + `, ${reel.footage || 'this story, moving'}`
            + `, with a voice reading it · [download](${raw(reel.files[0])})`
            + '\n\nInstagram takes no description on a reel, so `reel` always posts the'
            + ' cards with it.\n'
          : '',
        storyLine(story),
        '',
        captionBlock(read(post.caption)),
        '</details>',
      ]);
    }));

  // Named by section, because approving a section approves its posts, and
  // nobody wants to type seven post ids.
  const menu = sections.map(s => {
    const n = (s.posts || []).filter(p => p.kind === 'carousel').length;
    return `- \`${s.id}\` — **${s.label}** (${n} post${n === 1 ? '' : 's'})`
      + ((s.posts || []).some(p => p.kind === 'reel') ? ' · reel available' : '');
  }).join('\n');

  return {
    title: `Approve post — ${edition.id}`,
    labels: ['awaiting-approval'],
    body: join([
      (() => {
        const n = allPosts(edition).filter(p => p.kind === 'carousel').length;
        return `**${n} post${n === 1 ? '' : 's'} ready**, one per story.`
          + ' Nothing goes out unless you name it.';
      })(),
      '', menu, '',
      '---', '',
      blocks.join('\n\n'),
      checkBlock(warningsFor(edition)),
      refusedBlock(edition.refusals) ? `\n${refusedBlock(edition.refusals)}` : '',
      '',
      '---',
      '**To post, comment** `/approve <section>` — for example `/approve top business` —'
        + ' or name a single post, `/approve top-2`.',
      '`/approve all` posts everything. A bare `/approve` posts Top stories only.',
      reels.length
        ? 'Add `reel` to post the reel as well — `/approve top reel`. A reel never goes out'
          + ' on its own, because Instagram accepts no description on one.'
        : '',
      'Anything else, or no reply, and nothing is posted. Close this issue to discard it.',
    ]),
  };
}

/* ── A breaking story the watch caught ────────────────────────── */
function breakingIssue(edition, { raw, read }) {
  const section = edition.sections[0];
  const carousel = section.posts.find(p => p.kind === 'carousel');
  const s = section.stories[0];
  // How old the story is matters more here than anywhere else: the watch runs
  // every fifteen minutes and a "breaking" card about something from this
  // morning is not breaking.
  const age = s.published
    ? `${Math.round((Date.now() - Date.parse(s.published)) / 60000)} minutes old`
    : 'age unknown';

  return {
    title: `Breaking — ${String(s.display || s.headline || 'story').slice(0, 60)}`,
    labels: ['awaiting-approval', 'breaking'],
    body: join([
      '**Breaking — caught by the watch, not the daily run.**', '',
      carousel.files.map((p, i) => `![slide ${i + 1}](${raw(p)})`).join('\n'), '',
      `**${s.display || s.headline}**`,
      `_${s.source}_ · ${s.corroboration} independent newsroom`
        + `${s.corroboration > 1 ? 's' : ''} · ${age}`,
      s.link ? `\n${s.link}` : '',
      '',
      captionBlock(read(carousel.caption), '### Caption'),
      checkBlock(warningsFor(edition)),
      '',
      '---',
      '**Comment `/approve` to post this to Instagram.**'
        + ' Anything else, or no reply, and it is never posted.',
      'Close this issue to discard it — the watch stays quiet until you do.',
    ]),
  };
}

/* ── A correction ─────────────────────────────────────────────── */
function correctionIssue(edition, { raw, read, requestedBy }) {
  const section = edition.sections[0];
  const carousel = section.posts.find(p => p.kind === 'carousel');
  const c = section.stories[0]?.corrects || {};

  const notes = [];
  if (!c.mediaId) notes.push(
    'No Instagram media id is recorded for the original post, so this correction'
    + ' **cannot be attached as a comment to it** — it will go out as a standalone post.'
    + ' Posts made before the media id was recorded will all look like this.');
  else notes.push(
    `It will also be added as a comment on the original post (\`${c.mediaId}\`),`
    + ' so whoever finds the mistake finds the correction with it.');

  return {
    title: `Correction — ${edition.id}`,
    labels: ['awaiting-approval', 'correction'],
    body: join([
      `**Correction**${requestedBy ? ` — requested on #${requestedBy}.` : '.'}`, '',
      carousel.files.map((p, i) => `![correction ${i + 1}](${raw(p)})`).join('\n'), '',
      c.title ? `**Corrects:** ${c.title}\n${c.permalink || ''}`
              : '**Corrects:** (no original identified)',
      '',
      captionBlock(read(carousel.caption), '### Caption'),
      `\n### Note\n${notes.map(n => `- ${n}`).join('\n')}`,
      '',
      '---',
      '**Comment `/approve` to post this correction.**'
        + ' Anything else, or no reply, and it is never posted.',
      'The original post is not deleted. A channel that quietly removes its mistakes is',
      'less trustworthy than one that owns them.',
    ]),
  };
}

export function approvalIssue(edition, {
  owner, repo, sha, read = () => '', requestedBy = null,
} = {}) {
  const ctx = {
    raw: p => `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${p}`,
    read, requestedBy,
  };
  if (edition.kind === 'correction') return correctionIssue(edition, ctx);
  if (edition.kind === 'breaking')   return breakingIssue(edition, ctx);
  return dailyIssue(edition, ctx);
}
