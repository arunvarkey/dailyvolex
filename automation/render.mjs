#!/usr/bin/env node
/* Stage 2 — draw the cards the edition decided on.
 *
 * Loads the app itself in headless Chrome with the card in the URL, so what
 * comes out is exactly what the editor would produce. This file draws; it no
 * longer decides. Which layout a headline gets, what sits behind it and what
 * a blind reader is told are decisions, and they live in lib/compose.mjs
 * where they can be checked without a browser.
 *
 *   node automation/render.mjs [--ratio 4:5] [--theme bbc] [--edition <id>]
 *
 * Writes into the edition's own directory and records a post per section.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { launchChrome, closeChrome, openPage } from './lib/cdp.mjs';
import { findImage, downloadImage } from './lib/imagery.mjs';
import { imageFromArticle, isFurniture, biggerVariants,
         creditFor as articleCredit } from './lib/articleimage.mjs';
import { composeStoryPost, backdropOf, toQuery } from './lib/compose.mjs';
import { pixelSize, tooSmall } from './lib/pixels.mjs';
import { load, save, dirFor, attachPost } from './lib/edition.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/* Source photographs are an input to the renderer, not an output of it. They
   are baked into a slide within seconds and are never published, so they have
   no business in a commit — see docs/ARCHITECTURE.md. Everything under work/
   is git-ignored, which is the whole point of it. */
const WORK_PHOTOS = join(ROOT, 'work', 'photos');

/* JPEG, not PNG. A card is a photograph or a gradient behind type, which is
   what JPEG is for: the same slides came to 10.5 MB as PNG and 1.6 MB at
   quality 0.95, with no visible difference in the headline. Instagram
   re-encodes to JPEG whatever arrives, and a megabyte a day is a megabyte of
   git history every day, forever. */
const JPEG_QUALITY = 0.95;

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
                '.png':'image/png', '.css':'text/css',
                // Source photographs. Served as octet-stream they still drew,
                // because a browser sniffs an <img>, but there is no reason to
                // rely on that.
                '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' };

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

/* Serve the app from disk. file:// would do, but a real origin keeps the page
   behaving exactly as it does on GitHub Pages.
 *
 * Exported, along with the capture below, because the reel stage draws the
 * same cards upright and must draw them the same way. */
export function serve(root) {
  return new Promise(resolve => {
    const server = createServer(async (req, res) => {
      try {
        const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
        const path = join(root, rel === '/' ? 'index.html' : rel);
        if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
        const body = await readFile(path);
        res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
        res.end(body);
      } catch { res.writeHead(404).end(); }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* A composed card as a URL the app will draw. */
export const cardUrl = (port, spec) =>
  `http://127.0.0.1:${port}/index.html?${toQuery(spec.params)}`;

export async function renderUrl(url, index, { quality = JPEG_QUALITY } = {}) {
  const chrome = await launchChrome({ port: 9333 + index });
  try {
    const page = await openPage(chrome.port, url);

    // Wait for the app to say the fonts are in and a frame is painted. Never
    // capture before that or the headline renders in a fallback face.
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if (await page.evaluate('window.dvReady === true')) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    if (!ready) throw new Error('the page never became ready to capture');

    const type = quality ? `'image/jpeg', ${quality}` : `'image/png'`;
    const dataUrl = await page.evaluate(`document.getElementById('cv').toDataURL(${type})`);
    const want = quality ? 'data:image/jpeg' : 'data:image/png';
    if (!dataUrl || !dataUrl.startsWith(want)) throw new Error('no image came back');

    const dims = await page.evaluate(`JSON.stringify({w:cv.width,h:cv.height})`);
    const fontsOk = await page.evaluate('window.dvFontsOk');
    page.close();
    return { bytes: Buffer.from(dataUrl.split(',')[1], 'base64'), dims: JSON.parse(dims),
             fontsOk, jsErrors: page.errors.slice(0, 3) };
  } finally {
    await closeChrome(chrome);
  }
}

/* Try for a photograph; fall back to a generated backdrop. Never let this
   stop a run — a post with a backdrop behind it is fine, a failed run is not. */
const usedPhotos = new Set();       // one picture must not appear twice in a post

/* Run `fn` over the list with at most `limit` in flight. Enough to collapse
   the wall time, few enough to stay polite to a free API. */
async function mapWithLimit(list, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) {
      const i = next++;
      await fn(list[i], i);
    }
  });
  await Promise.all(workers);
}

/* Concurrent lookups can both settle on the same picture before either has
   marked it used, so the exclusion set cannot catch it. Rare, and obvious
   when it happens — the same photograph twice in one post. */
function dropDuplicatePhotos(stories) {
  const seen = new Set();
  for (const s of stories) {
    const id = s.photo?.pageUrl || s.photo?.path;
    if (!id) continue;
    if (seen.has(id)) {
      console.log(`  dropped a repeated photograph on "${(s.display || '').slice(0, 40)}…"`);
      s.photoError = 'the same photograph had already been used in this post';
      s.photo = null;
    } else seen.add(id);
  }
}

/* Where a story's picture comes from, best first.
 *
 * The article's own photograph is the only source that is reliably a picture
 * OF the story rather than a picture of its genre — a courthouse in the right
 * city, the actual minister, the actual wreck. It is also the outlet's
 * copyright, used without a licence, which is a decision the owner made
 * knowingly and which is why the outlet is named on the card and flagged in
 * the approval issue.
 *
 * The openly-licensed library stays as the fallback, so a story whose article
 * declares no picture still has a chance of one. */
async function findPhoto(story, opts) {
  if (!opts.noArticlePhotos) {
    /* Every outlet that carried the story, not only the one whose wording
       won. A story carried by Reuters and by Google News can end up led by
       the Google item, whose link is a redirect to an interstitial with no
       picture — so the Reuters link, which has one, was never tried. */
    const carried = story.sources?.length
      ? story.sources
      : [{ link: story.link, source: story.source, feedImage: story.feedImage }];

    /* The feed's own picture first of all. It costs nothing — the feed was
       already fetched — and it cannot be refused: NDTV answers 403 to a
       request for its article page and names the same photograph in its RSS
       without being asked. Feeds hand over thumbnails, though, so the
       bigger renditions go first and the thumbnail stays as the fallback. */
    const fromFeed = carried.filter(c => c.feedImage && !isFurniture(c.feedImage));
    if (fromFeed.length) {
      const c = fromFeed[0];
      const credit = articleCredit(c.source || story.source, c.link || c.feedImage);
      if (credit) return {
        image: { url: c.feedImage, credit, licence: 'publisher', pageUrl: c.link || null,
                 source: String(c.source || story.source || '').split('·')[0].trim() || null,
                 alternatives: [
                   // Bigger versions of this one, then whatever the other
                   // outlets named.
                   ...biggerVariants(c.feedImage).map(url => ({ url, credit, licence: 'publisher',
                      pageUrl: c.link || null })),
                   ...fromFeed.slice(1).flatMap(o => {
                     const oc = articleCredit(o.source || story.source, o.link || o.feedImage);
                     return oc ? [...biggerVariants(o.feedImage), o.feedImage]
                       .map(url => ({ url, credit: oc, licence: 'publisher', pageUrl: o.link || null }))
                       : [];
                   }),
                 ],
               },
        query: '(the feed)', error: null,
      };
    }

    for (const c of carried) {
      const fromArticle = await imageFromArticle(c.link, { source: c.source || story.source });
      if (fromArticle.image) return { image: fromArticle.image, query: '(the article)', error: null };
      story.articlePhotoError = `${c.source || '?'}: ${fromArticle.error}`;
    }
  }

  // The sensitivity rule applies to the LIBRARY only, and deliberately. It
  // exists because a stock photograph of an identifiable person under a story
  // about harm misrepresents them. The outlet's own picture of its own story
  // does not misrepresent anything — it is the photograph the story was
  // published with.
  // The topic steers the last-resort query. Without it, every story that named
  // nothing searchable fell back to a markets photo, so a standards conference
  // in Delhi was being illustrated with a trading screen.
  return findImage(story.display || story.headline,
                   { exclude: usedPhotos, topic: story.topic });
}

async function imageFor(story, index, opts, dir = '') {
  if (opts.noPhotos) return null;
  // A correction gets no photograph. There is no picture of being wrong, and
  // a stock image under one reads as an attempt to soften it.
  if (story.kind === 'correction') return null;

  const found = await findPhoto(story, opts);
  if (!found.image) {
    // Record the reason on the story: without it, "no picture" is impossible to
    // tell apart from "rate limited" or "the API is down" after the fact.
    story.photoError = `${found.error} (searched "${found.query}")`;
    console.log(`  no photo: ${story.photoError} — using the ${backdropOf(story, opts)} backdrop`);
    return null;
  }
  const name = `photo-${index}.jpg`;
  // Each section writes into its own folder, so photo-2.jpg in BUSINESS does
  // not overwrite photo-2.jpg in WORLD.
  const relDir = dir ? `${dir}/` : '';
  await mkdir(join(WORK_PHOTOS, dir), { recursive: true });
  // Links die, so a 404 on the best match should move to the next one rather
  // than cost the story its picture.
  const candidates = [found.image, ...(found.image.alternatives || [])];
  const failures = [];

  /* A small picture is held, not used.
   *
   * A feed hands over a thumbnail and names the full-size rendition one URL
   * along, so the first thing that downloads is often not the one to put on
   * the card: a 320-pixel photograph stretched to 1080 is soft and blocky,
   * and the channel was publishing them, because the only size test anywhere
   * was a byte count and a small picture of a busy scene outweighs a large
   * one of a clear sky. So a small one waits while the rest are tried, and is
   * used only if nothing bigger turns up — a story with a small photograph
   * still beats a story with none. */
  const heldPath = join(WORK_PHOTOS, dir, `held-${name}`);
  let held = null;
  const hold = what => {
    if (held && held.edge >= what.edge) return;
    // Under its own name, so the next candidate's download cannot overwrite it.
    renameSync(join(WORK_PHOTOS, dir, name), heldPath);
    held = what;
  };

  for (const cand of candidates) {
    // The 1600-pixel rendition first, the master only if it is missing. Both
    // the search and this download were written knowing a master buys nothing
    // for a canvas 1080 wide — and then asked for the master first anyway, so
    // the channel downloaded an 18 MB JPEG to put 1080 pixels of it on a card.
    for (const url of [cand.smallerUrl, cand.url].filter(Boolean)) {
    try {
      const dest = join(WORK_PHOTOS, dir, name);
      const { bytes } = await downloadImage(url, dest);
      // A masthead or a share icon declared as og:image comes back a few
      // kilobytes. A photograph does not, and a card wearing a newspaper's
      // logo looks like a mistake because it is one.
      if (bytes < 12_000) throw new Error(`only ${(bytes/1024).toFixed(0)} KB — furniture, not a photograph`);

      const size = pixelSize(readFileSync(dest));
      const got = { path: `work/photos/${relDir}${name}`, credit: cand.credit,
               license: cand.license ?? cand.licence ?? null, pageUrl: cand.pageUrl,
               query: found.query, relevance: cand.relevance, title: cand.title,
               url: cand.url,
               size: size ? `${size.width}×${size.height}` : null,
               // Unknown counts as big enough: refusing a picture because its
               // header was unfamiliar would quietly cost stories their photo.
               edge: size ? Math.max(size.width, size.height) : Infinity,
               // Where it came from, so the approval issue can say so and the
               // record of what was published is honest about it.
               from: cand.licence === 'publisher' ? 'article' : 'library' };

      const small = tooSmall(size);
      if (small) { failures.push(small); hold(got); continue; }

      usedPhotos.add(cand.url);
      console.log(`  photo: "${found.query}" · match ${cand.relevance ?? '?'}`
        + ` · ${cand.credit} · ${(bytes/1024).toFixed(0)} KB${got.size ? ` · ${got.size}` : ''}`
        + (failures.length ? `  (after ${failures.length} rejected)` : ''));
      return got;
    } catch (e) {
      failures.push(e.message);
    }
    }
    usedPhotos.add(cand.url);            // do not retry a dead link elsewhere
  }

  // Nothing was big enough. The best of the small ones still beats no picture,
  // and the approval issue says it was small so the owner can judge.
  if (held) {
    renameSync(heldPath, join(WORK_PHOTOS, dir, name));
    usedPhotos.add(held.url);
    console.log(`  photo: "${found.query}" · ${held.credit} · ${held.size}`
      + ' — the largest any outlet offered, and smaller than the card');
    story.photoSmall = held.size;
    return held;
  }

  story.photoError = `every candidate failed to download (${failures.join('; ')})`;
  console.log(`  no photo: ${story.photoError} — using the ${backdropOf(story, opts)} backdrop`);
  return null;
}

async function main() {
  const today = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
  const opts = {
    layout: arg('layout', 'breaking'),
    theme:  arg('theme', 'bbc'),
    ratio:  arg('ratio', '4:5'),       // 4:5 is the largest Instagram feed size
    /* The strip along the foot of every card.
     *
     * It used to read "DAILYVOLEX ··· TODAY'S NEWS ···", which is the card
     * telling you what you are already looking at. It is the one piece of
     * furniture on every single card, and 7 posts out of 8 are a single card
     * with no other invitation to follow anywhere on the image. So it says
     * the one useful thing instead. */
    ticker: arg('ticker', 'FOLLOW @DAILYVOLEX FOR MORE STORIES LIKE THIS  ···  '),
    date:   arg('date', today),
    // Lifts the headline block off the bottom edge. Without it the card is
    // weighted right at the base of an otherwise empty frame.
    posy: arg('posy', '0'),
    bg:   arg('bg', 'chart'),
    // An explicit --bg is an instruction and overrides the per-story choice;
    // the default must not, or every card gets the chart again.
    bgExplicit: process.argv.includes('--bg'),
    noPhotos: process.argv.includes('--no-photos'),
    // Library only, for comparing coverage with and without.
    noArticlePhotos: process.argv.includes('--no-article-photos'),
  };

  const edition = await load(ROOT, arg('edition'));
  const outDir = join(ROOT, dirFor(edition.id));
  let fontWarnings = 0;

  const { server, port } = await serve(ROOT);
  try {
    for (const section of edition.sections) {
      const stories = section.stories.filter(s => s.usable !== false);
      if (!stories.length) { console.log(`\n── ${section.label} — nothing usable ──`); continue; }
      console.log(`\n── ${section.label} (${stories.length}) ──`);

      /* Look the photographs up together rather than one at a time.
         Searching serially meant a slow API ate the run's whole budget, and
         the answer to that was NOT the shorter timeout I reached for first:
         cutting it from twenty seconds to ten took the picture rate from
         most cards to one in thirteen. These are independent network calls.
         Done three at a time they cost about what one did. */
      await mapWithLimit(stories, 3, async (story, i) => {
        story.photo = await imageFor(story, `${section.id}-${i + 2}`, opts, section.id);
      });
      dropDuplicatePhotos(stories);

      /* One post per story, not one carousel per section.
       *
       * A section carousel put six unrelated stories behind one cover: you
       * tapped for the first and swiped past five you had not chosen. A post
       * about one thing can be judged on its own, shared on its own, and
       * corrected on its own. */
      for (const [i, story] of stories.entries()) {
        const n = i + 1;
        const dir = `${section.id}/${n}`;
        // Every decision about every card, made in one pure call before a
        // single pixel is drawn.
        const specs = composeStoryPost(story, { ...opts, label: section.label });

        await mkdir(join(outDir, dir), { recursive: true });
        const files = [];
        for (const [c, spec] of specs.entries()) {
          const slide = await renderUrl(cardUrl(port, spec), c);
          const name = `slide-${c + 1}.jpg`;
          await writeFile(join(outDir, dir, name), slide.bytes);
          files.push(`${dirFor(edition.id)}/${dir}/${name}`);
          console.log(`rendered ${dir}/${name}  ${slide.dims.w}x${slide.dims.h}`
            + `  ${(slide.bytes.length / 1024).toFixed(0)} KB  ${spec.kind}`
            + (slide.fontsOk === false ? '  !! WEB FONTS DID NOT LOAD' : '')
            + (slide.jsErrors.length ? `  (page errors: ${slide.jsErrors.join(' | ')})` : ''));
          if (slide.fontsOk === false) fontWarnings++;
        }

        // A news account that publishes images without alt text shuts blind
        // readers out of the news. Written beside the slides, in slide order,
        // so it reaches the publisher without going through a shell.
        await writeFile(join(outDir, dir, 'alt.json'),
                        JSON.stringify(specs.map(x => x.alt), null, 2) + '\n', 'utf8');

        attachPost(edition, section.id, {
          kind: 'carousel',
          id: `${section.id}-${n}`,
          story: story.display || story.headline,
          files,
          cover: files[0],
          alts: `${dirFor(edition.id)}/${dir}/alt.json`,
          // caption.mjs fills this in; validate() refuses an edition without it.
          caption: '',
          // A correction is attached to the post it corrects, so whoever finds
          // the mistake finds the correction with it.
          commentOn: story?.corrects?.mediaId || '',
          commentFile: story?.corrects?.commentFile || '',
        });
      }
    }
  } finally {
    server.close();
  }

  const made = edition.sections.flatMap(s => s.posts);
  // Precise, because "nothing rendered" sent me hunting through a stubbed
  // network for a bug that was not there: the edition was empty before the
  // renderer ever saw it.
  if (!made.length) throw new Error(
    edition.sections.length
      ? `${edition.sections.length} section(s) but no usable story in any of them`
      : 'this edition has no sections — the shortlist found nothing to publish');
  await save(ROOT, edition);

  console.log(`\n${made.length} post(s) in ${dirFor(edition.id)}`);
  if (fontWarnings) {
    const msg = `${fontWarnings} graphic(s) rendered WITHOUT the brand typeface — the headline `
      + `is in a fallback face. Check the machine can reach fonts.googleapis.com.`;
    // --require-fonts turns this into a failure, so CI proves the typeface
    // loads rather than printing a warning nobody reads.
    if (process.argv.includes('--require-fonts')) throw new Error(msg);
    console.log('WARNING: ' + msg);
  }
}

/* Only when run as a stage. The reel stage imports the capture above, and an
   unguarded call here would make that import re-render the whole day. */
if (process.argv[1] && process.argv[1].endsWith('render.mjs'))
  main().catch(err => { console.error('render failed:', err.message); process.exit(1); });
