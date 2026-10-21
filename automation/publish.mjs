#!/usr/bin/env node
/* Stage 3 — publish an approved graphic to Instagram.
 *
 * Runs ONLY after a human approves. Nothing in this file is reached by the
 * scheduled job; the approval workflow invokes it.
 *
 * Needs two secrets:
 *   IG_USER_ID       the Instagram Business/Creator account id
 *   IG_ACCESS_TOKEN  a long-lived token for that account
 *
 *   node automation/publish.mjs --image <public url> --caption-file <path> [--dry-run]
 *                               [--alt-file <path>]   descriptions, one per image
 *                               [--comment-on <media id> --comment <text>]
 *   node automation/publish.mjs --video <public url> --caption-file <path> [--cover <url>]
 *
 * A reel takes no descriptions: Instagram accepts `alt_text` when an image
 * container is created and a reel is not one, so passing it would be a silent
 * no-op that looked like accessibility. The headlines go in the caption, and
 * the approval plan never offers a reel without the carousel beside it.
 *
 * --comment-on attaches a correction to the post it corrects, so that anyone
 * who finds the wrong post finds the correction with it.
 *
 * Instagram requires the image to be fetchable from a public URL — it pulls
 * the file itself rather than accepting an upload — which is why the graphic
 * is published to GitHub Pages first.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const GRAPH = 'https://graph.facebook.com/v21.0';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const FLAG = n => process.argv.includes(`--${n}`);
const wait = ms => new Promise(r => setTimeout(r, ms));

async function graph(path, params, method = 'POST') {
  const url = new URL(`${GRAPH}/${path}`);
  const body = new URLSearchParams(params);
  const res = method === 'GET'
    ? await fetch(`${url}?${body}`)
    : await fetch(url, { method, body });

  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok || json.error) {
    const e = json.error || {};
    // Report what Meta actually said; these errors are specific and the
    // guesswork otherwise costs hours.
    throw new Error(`Instagram API ${res.status}: ${e.message || text}`
      + (e.error_user_msg ? ` — ${e.error_user_msg}` : '')
      + (e.code ? ` [code ${e.code}]` : ''));
  }
  return json;
}

/* A container is not ready the moment it is created; publishing too early
   fails with a misleading error. A video takes far longer than an image —
   Meta transcodes it — so the caller says how long to wait. */
async function waitForContainer(id, token, { tries = 30, gap = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await graph(id, { fields: 'status_code,status', access_token: token }, 'GET');
    if (r.status_code === 'FINISHED') return;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED')
      throw new Error(`media container ${r.status_code}: ${r.status || 'no detail'}`);
    await wait(gap);
  }
  throw new Error('media container was not ready in time');
}

/* Check Instagram can actually fetch what it is about to be given. It pulls
   the file itself rather than accepting an upload, so an unreachable URL is a
   failure half way through a carousel rather than before it starts. */
async function reachable(url) {
  const r = await fetch(url, { method: 'GET', headers: { range: 'bytes=0-0' } }).catch(() => null);
  return r?.ok ? (r.headers.get('content-type') || '') : null;
}

/* A reel.
 *
 * Deliberately NOT given alt text: Instagram takes `alt_text` when an image
 * container is created and a reel is not an image container, so passing it
 * would be a silent no-op that looked like accessibility. The headlines are
 * in the caption instead, and the plan never offers a reel without the
 * carousel that carries the descriptions.
 */
async function publishReel(userId, token, { video, cover, caption }) {
  const type = await reachable(video);
  if (type === null) throw new Error(`this video is not publicly reachable: ${video}`);
  if (!/^video\//.test(type))
    console.warn(`NOTE: ${video}\n  is served as "${type || 'no type'}" rather than video/mp4.`
      + ' GitHub serves raw files as application/octet-stream and Meta usually accepts it;'
      + ' if the container errors below, that is the first thing to suspect.');

  console.log('creating the reel container…');
  const container = await graph(`${userId}/media`, {
    media_type: 'REELS',
    video_url: video,
    caption,
    // Also on the profile grid, not only in the Reels tab. A news channel's
    // profile reading as empty because everything went to a separate tab
    // helps nobody.
    share_to_feed: 'true',
    ...(cover ? { cover_url: cover } : {}),
    access_token: token,
  });
  // Meta transcodes the video, which takes minutes rather than seconds.
  console.log(`container ${container.id} — Meta is transcoding; this takes a few minutes…`);
  await waitForContainer(container.id, token, { tries: 60, gap: 5000 });
  return container;
}

/* Descriptions for blind readers, one per image in slide order. Read from a
   file rather than argv: this text is long, contains quotation marks and em
   dashes, and has no business passing through a shell. */
async function loadAlts(file, expected) {
  if (!file) return [];
  let alts = [];
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(parsed)) alts = parsed.map(a => String(a || ''));
  } catch (e) {
    // Never fail a post over this, but never let it pass unnoticed either.
    console.warn(`WARNING: could not read alt text from ${file}: ${e.message}`);
  }
  if (alts.length && alts.length !== expected)
    console.warn(`WARNING: ${alts.length} descriptions for ${expected} images`
      + ' — some slides will publish without one.');
  return alts;
}

async function loadCaption(file, fallback = '') {
  const text = file ? await readFile(file, 'utf8') : fallback;
  return text.trim().slice(0, 2200);                // Instagram's caption limit
}

/* Publish exactly one post: a carousel, a single image, or a reel. */
async function publishOne(spec, { userId, token, dryRun }) {
  const { id, kind, urls, caption, alts = [], commentOn, commentText, section, cover } = spec;
  const video = kind === 'reel' ? urls[0] : null;
  const images = kind === 'reel' ? [] : urls;

  if (dryRun) {
    console.log('DRY RUN — nothing will be posted');
    if (video) {
      console.log(`reel: ${video}`);
      console.log('  no description — Instagram accepts none on a reel;'
        + ' the headlines are in the caption below');
    }
    if (images.length) console.log(images.length > 1 ? `carousel of ${images.length}:` : 'image:');
    for (const [n, i] of images.entries()) {
      console.log('  ' + i);
      console.log('    alt: ' + (alts[n] || '(none — this slide would publish without a description)'));
    }
    console.log('caption:\n' + caption);
    return null;
  }

  // Instagram fetches these itself, so check every one is reachable before
  // starting — a carousel that fails on its last child wastes the rest.
  for (const url of images)
    if (await reachable(url) === null)
      throw new Error(`this image is not publicly reachable: ${url}`);

  let container;
  if (video) {
    container = await publishReel(userId, token, { video, cover, caption });
  } else if (images.length === 1) {
    console.log('creating media container…');
    container = await graph(`${userId}/media`, {
      image_url: images[0], caption, access_token: token,
      // Accessibility. Meta added alt_text to image containers in March 2025;
      // it is set when the container is created, not at publish time.
      ...(alts[0] ? { alt_text: alts[0].slice(0, 1000) } : {}),
    });
    console.log(`container ${container.id} — waiting for it to be ready…`);
    await waitForContainer(container.id, token);
  } else {
    console.log(`creating ${images.length} carousel items…`);
    const children = [];
    for (const [i, url] of images.entries()) {
      // Each slide of a carousel carries its own description — a reader
      // swiping through gets the same per-card detail a sighted one does.
      const child = await graph(`${userId}/media`, {
        image_url: url, is_carousel_item: 'true', access_token: token,
        ...(alts[i] ? { alt_text: alts[i].slice(0, 1000) } : {}),
      });
      await waitForContainer(child.id, token);
      console.log(`  slide ${i + 1}/${images.length} ready`);
      children.push(child.id);
    }
    console.log('creating the carousel…');
    container = await graph(`${userId}/media`, {
      media_type: 'CAROUSEL', children: children.join(','), caption, access_token: token,
    });
    await waitForContainer(container.id, token);
  }

  console.log('publishing…');
  const published = await graph(`${userId}/media_publish`, {
    creation_id: container.id, access_token: token,
  });

  console.log(`published — media id ${published.id}`);

  // The permalink is what a correction has to point at, and what makes the
  // repo's record of what went out checkable by a person rather than only by
  // the API. Not worth failing a successful post over, though.
  let permalink = null;
  try {
    const meta = await graph(published.id, { fields: 'permalink', access_token: token }, 'GET');
    permalink = meta.permalink || null;
    if (permalink) console.log(permalink);
  } catch (e) {
    console.warn(`could not read the permalink: ${e.message}`);
  }

  await recordPublished({
    mediaId: published.id, permalink, caption,
    images: urls, kind,
    // The post, not just its section: a section is several posts now, and the
    // ledger has to attribute each media id to the story it is of.
    post: id || null,
    section: section || null, corrects: commentOn || null,
    postedAt: new Date().toISOString(),
  });

  // A correction is attached to the post it corrects, so anyone who finds the
  // wrong post finds the correction with it. A new post on its own reaches
  // today's readers and nobody who saw the original. This needs
  // instagram_manage_comments on top of the publishing permissions, so it is
  // best-effort: a correction that posted but could not be pinned to the
  // original is still a correction, and failing here would make it look as
  // though nothing was corrected at all.
  if (commentOn && commentText) {
    try {
      const r = await graph(`${commentOn}/comments`, { message: commentText, access_token: token });
      console.log(`comment ${r.id} added to the corrected post ${commentOn}`);
    } catch (e) {
      console.warn(`WARNING: could not comment on ${commentOn}: ${e.message}`);
      console.warn('The correction was posted. It is not pinned to the original;'
        + ' add the comment by hand, and check the token has instagram_manage_comments.');
    }
  }
  return { mediaId: published.id, permalink };
}

/* The text of a correction, read from a file for the same reason as the alt
   text: a person wrote it in a GitHub comment and it must not pass through a
   shell on its way here. */
async function correctionText() {
  const file = arg('comment-file');
  if (!file) return arg('comment');
  try { return (await readFile(file, 'utf8')).trim(); }
  catch (e) { console.warn(`could not read ${file}: ${e.message}`); return arg('comment'); }
}

/* One post, described by the command line. */
async function specFromArgv() {
  // Either one image, or several for a carousel. A carousel is the stronger
  // format for a daily roundup — a cover that earns the tap and a readable
  // card per story — so it is worth supporting properly rather than posting
  // three separate images.
  const images = (arg('images', '') || arg('image', ''))
    .split(',').map(s => s.trim()).filter(Boolean);
  const video = arg('video', '');

  if (!images.length && !video)
    throw new Error('--image <url>, --images <url,url,...> or --video <url> is required');
  if (images.length > 10) throw new Error('Instagram allows at most 10 images in a carousel');

  return {
    label: video ? 'reel' : 'post',
    kind: video ? 'reel' : (images.length > 1 ? 'carousel' : 'image'),
    urls: video ? [video] : images,
    caption: await loadCaption(arg('caption-file'), arg('caption', '')),
    alts: await loadAlts(arg('alt-file'), images.length),
    commentOn: arg('comment-on', ''),
    commentText: await correctionText(),
    section: arg('section', null),
    cover: arg('cover', ''),
  };
}

/* Every post an approval asked for, in the order it asked. Written by
   `dv.mjs plan`, which is where the decision was made — this only carries it
   out, so a disagreement between what the owner approved and what goes out
   can only come from one place. */
async function specsFromPlan(file) {
  const decided = JSON.parse(await readFile(file, 'utf8'));
  const posts = decided.posts || [];
  if (!posts.length) throw new Error(`${file} names no posts`);
  const out = [];
  for (const p of posts) {
    if (p.kind === 'carousel' && p.urls.length > 10)
      throw new Error(`${p.label} has ${p.urls.length} slides; Instagram takes 10`);
    out.push({
      id: p.id, label: p.label, kind: p.kind, urls: p.urls, section: p.section,
      caption: await loadCaption(p.caption),
      // A reel gets none, and must not look as though it did.
      alts: p.kind === 'reel' ? [] : await loadAlts(p.alts, p.urls.length),
      commentOn: p.commentOn || '',
      // The correction text travels with the plan, not as a flag on the
      // command line: it is written by a person in a GitHub comment.
      commentText: p.commentFile ? (await readFile(p.commentFile, 'utf8')).trim() : '',
      cover: p.cover || '',
    });
  }
  return out;
}

async function main() {
  const dryRun = FLAG('dry-run');
  const planFile = arg('plan');
  const specs = planFile ? await specsFromPlan(planFile) : [await specFromArgv()];

  let userId = null, token = null;
  if (!dryRun) {
    userId = process.env.IG_USER_ID;
    token  = process.env.IG_ACCESS_TOKEN;
    if (!userId || !token)
      throw new Error('IG_USER_ID and IG_ACCESS_TOKEN must be set — see automation/README.md');
  }

  // One Instagram post at a time, in the order asked for. A failure part-way
  // through stops the rest: half a morning posted is recoverable, but
  // carrying on past an error is how the same post goes out twice.
  for (const [i, spec] of specs.entries()) {
    if (specs.length > 1) console.log(`\n── ${i + 1}/${specs.length}  ${spec.label} ──`);
    await publishOne(spec, { userId, token, dryRun });
  }
}

/* Append to work/published.json — what Instagram gave back, which dv.mjs
   record folds into data/ledger.json, the repo's permanent record. It goes
   under work/ because it is a receipt for this run, not something to commit:
   the ledger is the committed thing. */
async function recordPublished(entry) {
  const path = arg('record', 'work/published.json');
  let all = [];
  try { all = JSON.parse(await readFile(path, 'utf8')); } catch { /* first post */ }
  if (!Array.isArray(all)) all = [];
  all.push(entry);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(all, null, 2) + '\n', 'utf8');
  console.log(`recorded in ${path}`);
}

main().catch(err => { console.error('publish failed:', err.message); process.exit(1); });
