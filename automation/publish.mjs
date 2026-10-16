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
 *
 * Instagram requires the image to be fetchable from a public URL — it pulls
 * the file itself rather than accepting an upload — which is why the graphic
 * is published to GitHub Pages first.
 */

import { readFile } from 'node:fs/promises';

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
  const image = arg('image');
  const captionFile = arg('caption-file');
  const dryRun = FLAG('dry-run');

  if (!image) throw new Error('--image <public url> is required');

  let caption = arg('caption', '');
  if (captionFile) caption = await readFile(captionFile, 'utf8');
  caption = caption.trim().slice(0, 2200);          // Instagram's caption limit

  if (dryRun) {
    console.log('DRY RUN — nothing will be posted');
    console.log('image:  ', image);
    console.log('caption:\n' + caption);
    return;
  }

  const userId = process.env.IG_USER_ID;
  const token  = process.env.IG_ACCESS_TOKEN;
  if (!userId || !token)
    throw new Error('IG_USER_ID and IG_ACCESS_TOKEN must be set — see automation/README.md');

  // Instagram must be able to reach the image itself.
  const head = await fetch(image, { method: 'GET', headers: { range: 'bytes=0-0' } }).catch(() => null);
  if (!head || !head.ok)
    throw new Error(`the image URL is not publicly reachable: ${image}`);

  console.log('creating media container…');
  const container = await graph(`${userId}/media`, {
    image_url: image, caption, access_token: token,
  });

  console.log(`container ${container.id} — waiting for it to be ready…`);
  await waitForContainer(container.id, token);

  console.log('publishing…');
  const published = await graph(`${userId}/media_publish`, {
    creation_id: container.id, access_token: token,
  });

  console.log(`published: https://www.instagram.com/p/${published.id ? '' : ''}`.trim());
  console.log(JSON.stringify(published));
}

main().catch(err => { console.error('publish failed:', err.message); process.exit(1); });
