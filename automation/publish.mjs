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
 *                               [--comment-on <media id> --comment <text>]
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
   fails with a misleading error. */
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

async function main() {
  // Either one image, or several for a carousel. A carousel is the stronger
  // format for a daily roundup — a cover that earns the tap and a readable
  // card per story — so it is worth supporting properly rather than posting
  // three separate images.
  const images = (arg('images', '') || arg('image', ''))
    .split(',').map(s => s.trim()).filter(Boolean);
  const captionFile = arg('caption-file');
  const dryRun = FLAG('dry-run');

  if (!images.length) throw new Error('--image <url> or --images <url,url,...> is required');
  if (images.length > 10) throw new Error('Instagram allows at most 10 images in a carousel');

  let caption = arg('caption', '');
  if (captionFile) caption = await readFile(captionFile, 'utf8');
  caption = caption.trim().slice(0, 2200);          // Instagram's caption limit

  if (dryRun) {
    console.log('DRY RUN — nothing will be posted');
    console.log(images.length > 1 ? `carousel of ${images.length}:` : 'image:');
    for (const i of images) console.log('  ' + i);
    console.log('caption:\n' + caption);
    return;
  }

  const userId = process.env.IG_USER_ID;
  const token  = process.env.IG_ACCESS_TOKEN;
  if (!userId || !token)
    throw new Error('IG_USER_ID and IG_ACCESS_TOKEN must be set — see automation/README.md');

  // Instagram fetches these itself, so check every one is reachable before
  // starting — a carousel that fails on its last child wastes the rest.
  for (const url of images) {
    const head = await fetch(url, { method: 'GET', headers: { range: 'bytes=0-0' } }).catch(() => null);
    if (!head || !head.ok) throw new Error(`this image is not publicly reachable: ${url}`);
  }

  let container;
  if (images.length === 1) {
    console.log('creating media container…');
    container = await graph(`${userId}/media`, {
      image_url: images[0], caption, access_token: token,
    });
    console.log(`container ${container.id} — waiting for it to be ready…`);
    await waitForContainer(container.id, token);
  } else {
    console.log(`creating ${images.length} carousel items…`);
    const children = [];
    for (const [i, url] of images.entries()) {
      const child = await graph(`${userId}/media`, {
        image_url: url, is_carousel_item: 'true', access_token: token,
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
    mediaId: published.id, permalink, caption, images,
    section: arg('section', null), corrects: arg('comment-on', null),
    postedAt: new Date().toISOString(),
  });

  // A correction is attached to the post it corrects, so anyone who finds the
  // wrong post finds the correction with it. A new post on its own reaches
  // today's readers and nobody who saw the original. This needs
  // instagram_manage_comments on top of the publishing permissions, so it is
  // best-effort: a correction that posted but could not be pinned to the
  // original is still a correction, and failing here would make it look as
  // though nothing was corrected at all.
  const commentOn = arg('comment-on');
  // From a file, never from argv: this text is written by a person in a
  // GitHub comment and must not pass through a shell on its way here.
  const commentFile = arg('comment-file');
  let commentText = arg('comment');
  if (commentFile) {
    try { commentText = (await readFile(commentFile, 'utf8')).trim(); }
    catch (e) { console.warn(`could not read ${commentFile}: ${e.message}`); }
  }
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
}

/* Append to data/pending/published.json. The approval workflow merges this
   into data/posted.json, which is the repo's permanent record. */
async function recordPublished(entry) {
  const path = arg('record', 'data/pending/published.json');
  let all = [];
  try { all = JSON.parse(await readFile(path, 'utf8')); } catch { /* first post */ }
  if (!Array.isArray(all)) all = [];
  all.push(entry);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(all, null, 2) + '\n', 'utf8');
  console.log(`recorded in ${path}`);
}

main().catch(err => { console.error('publish failed:', err.message); process.exit(1); });
