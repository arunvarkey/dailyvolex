#!/usr/bin/env node
/* Stage 2 — turn the shortlist into finished graphics.
 *
 * Loads the app itself in headless Chrome with the story in the URL, so what
 * comes out is exactly what the editor would produce. Writes PNGs to
 * data/pending/ and records them in the shortlist.
 *
 *   node automation/render.mjs [--ratio 4:5] [--theme bbc] [--layout breaking]
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { launchChrome, closeChrome, openPage } from './lib/cdp.mjs';
import { readJson, writeJson } from './lib/store.mjs';
import { findImage, downloadImage, backdropFor } from './lib/imagery.mjs';
import { altForEntry, altForStory } from './lib/alttext.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHORTLIST = join(ROOT, 'data', 'shortlist.json');
const OUT_DIR   = join(ROOT, 'data', 'pending');

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
                '.png':'image/png', '.css':'text/css' };

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

/* Serve the app from disk. file:// would do, but a real origin keeps the page
   behaving exactly as it does on GitHub Pages. */
function serve(root) {
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

/* One card carrying every headline — the classic daily-roundup format, and a
   better fit than a single Breaking card when there is no video behind it. */
function digestUrl(port, stories, opts) {
  const q = new URLSearchParams({
    auto: '1', layout: 'stories', theme: opts.theme, ratio: opts.ratio,
    label: opts.label, date: opts.date, ticker: opts.ticker, bg: opts.bg,
  });
  // The outlet's own capitalisation, untouched.
  for (const s of stories) q.append('item', s.display || s.headline);
  return `http://127.0.0.1:${port}/index.html?${q}`;
}

/* Try for a photograph; fall back to a generated backdrop. Never let this stop
   a run — a post with a backdrop behind it is fine, a failed run is not. */
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

/* What goes behind this card when there is no photograph. Named here so the
   log line and the URL cannot disagree about it. */
function backdropOf(story, opts) {
  // A correction is never illustrated. The first one rendered came out over a
  // market chart, because the text it was correcting said "Sensex" and
  // "points" — a chart behind an apology is decoration, and a chart that
  // looks like the figure we got wrong is worse than decoration.
  if (story.kind === 'correction') return 'editorial';
  if (opts.bgExplicit) return opts.bg;
  return backdropFor(story.display || story.headline, story.topic);
}

async function imageFor(story, index, opts, dir = '') {
  if (opts.noPhotos) return null;
  // Nor does a correction get a photograph. There is no picture of being
  // wrong, and a stock image under one reads as an attempt to soften it.
  if (story.kind === 'correction') return null;
  // The topic steers the last-resort query. Without it, every story that named
  // nothing searchable fell back to a markets photo, so a standards conference
  // in Delhi was being illustrated with a trading screen.
  const found = await findImage(story.display || story.headline,
                               { exclude: usedPhotos, topic: story.topic });
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
  // Openverse indexes links that have since died, so a 404 on the best match
  // should move to the next one rather than cost the story its picture.
  const candidates = [found.image, ...(found.image.alternatives || [])];
  const failures = [];

  for (const cand of candidates) {
    for (const url of [cand.url, cand.smallerUrl].filter(Boolean)) {
    try {
      const { bytes } = await downloadImage(url, join(OUT_DIR, dir, name));
      usedPhotos.add(cand.url);
      console.log(`  photo: "${found.query}" · match ${cand.relevance ?? '?'}`
        + ` · ${cand.credit} · ${(bytes/1024).toFixed(0)} KB`
        + (failures.length ? `  (after ${failures.length} dead link${failures.length>1?'s':''})` : ''));
      return { path: `data/pending/${relDir}${name}`, credit: cand.credit,
               license: cand.license, pageUrl: cand.pageUrl,
               query: found.query, relevance: cand.relevance, title: cand.title };
    } catch (e) {
      failures.push(e.message);
    }
    }
    usedPhotos.add(cand.url);            // do not retry a dead link elsewhere
  }

  story.photoError = `every candidate failed to download (${failures.join('; ')})`;
  console.log(`  no photo: ${story.photoError} — using the ${backdropOf(story, opts)} backdrop`);
  return null;
}

function storyUrl(port, story, opts) {
  const q = new URLSearchParams({
    auto: '1',
    layout: opts.layout,
    theme: opts.theme,
    ratio: opts.ratio,
    category: story.category,
    headline: story.headline,
    source: story.source,
    ticker: opts.ticker,
    // A photograph covers the whole frame, so the backdrop behind it never
    // shows; without one, the choice of backdrop is part of what the card
    // says, and is made per story rather than once for the whole run.
    // Recorded on the story as well as sent in the URL: the alt text has to
    // describe what is actually behind the headline, and it was calling
    // every card "a plain brand design" because nothing wrote this down.
    bg: story.photo ? opts.bg : (story.backdrop = backdropOf(story, opts)),
  });
  if (opts.posy != null) q.set('posy', String(opts.posy));
  if (story.photo) { q.set('img', story.photo.path); q.set('credit', story.photo.credit); }
  return `http://127.0.0.1:${port}/index.html?${q}`;
}

async function renderUrl(url, index) {
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

    const dataUrl = await page.evaluate(`document.getElementById('cv').toDataURL('image/png')`);
    if (!dataUrl || !dataUrl.startsWith('data:image/png')) throw new Error('no image came back');

    const dims = await page.evaluate(`JSON.stringify({w:cv.width,h:cv.height})`);
    const fontsOk = await page.evaluate('window.dvFontsOk');
    if (process.env.DV_DEBUG) console.log('   debug:',
      await page.evaluate(`JSON.stringify({freeze:S.tickerFreeze,x:S.tickerX,raf:!!S.raf,headless:HEADLESS})`));
    page.close();
    return { png: Buffer.from(dataUrl.split(',')[1], 'base64'), dims: JSON.parse(dims),
             fontsOk, jsErrors: page.errors.slice(0, 3) };
  } finally {
    await closeChrome(chrome);
  }
}

async function main() {
  const today = new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
  const opts = {
    layout: arg('layout', 'breaking'),
    theme:  arg('theme', 'bbc'),
    ratio:  arg('ratio', '4:5'),       // 4:5 is the largest Instagram feed size
    ticker: arg('ticker', 'DAILYVOLEX  ···  TODAY\u2019S NEWS  ···  '),
    label:  arg('label', 'TOP STORIES'),
    date:   arg('date', today),
    digest: process.argv.includes('--digest'),
    // A carousel is the strongest format for a daily news post: the cover
    // earns the tap, each story gets a readable card of its own, and people
    // save and share multi-slide posts far more than single images.
    carousel: process.argv.includes('--carousel'),
    // A post per section — Top stories, India, World, Business, Technology.
    sections: process.argv.includes('--sections'),
    // Lifts the headline block off the bottom edge. Without it the card is
    // weighted right at the base of an otherwise empty frame.
    // With a chart behind the text the frame is full, so the headline sits in
    // its normal place rather than being lifted to fill emptiness.
    posy: arg('posy', '0'),
    bg:   arg('bg', 'chart'),
    // An explicit --bg is an instruction and overrides the per-story choice;
    // the default must not, or every card gets the chart again.
    bgExplicit: process.argv.includes('--bg'),
    noPhotos: process.argv.includes('--no-photos'),
  };

  const shortlist = await readJson(SHORTLIST, null);
  if (!shortlist || !shortlist.stories?.length) throw new Error('no shortlist — run shortlist.mjs first');

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const { server, port } = await serve(ROOT);
  const rendered = [];
  let fontWarnings = 0;
  try {
    const usable = shortlist.stories.filter(s => s.usable);

    /* One carousel: a cover listing what is inside, then a card per story.
       Parameterised by output folder so a sectioned run can put each
       section's post in its own, rather than four sections overwriting one
       another's slide-1.png. */
    const renderCarousel = async (stories, carouselOpts, dir, label) => {
      await mkdir(join(OUT_DIR, dir), { recursive: true });
      const rel = f => `data/pending/${dir ? dir + '/' : ''}${f}`;
      const slides = [];

      const cover = await renderUrl(digestUrl(port, stories, carouselOpts), 0);
      await writeFile(join(OUT_DIR, dir, 'slide-1.png'), cover.png);
      slides.push({ file: 'slide-1.png', kind: 'cover', ...cover });

      /* Look the photographs up together rather than one at a time.
         Searching serially meant a slow API ate the run's whole budget, and
         the answer to that was NOT the shorter timeout I reached for first:
         cutting it from twenty seconds to ten took the picture rate from
         most cards to one in thirteen, with eight stories timing out on
         perfectly good queries like "Marco Rubio". These are independent
         network calls. Done three at a time they cost about what one did. */
      await mapWithLimit(stories, 3, async (story, i) => {
        story.photo = await imageFor(story, `${dir || 'top'}-${i + 2}`, carouselOpts, dir);
      });
      dropDuplicatePhotos(stories);

      for (const [i, story] of stories.entries()) {
        const slide = await renderUrl(
          storyUrl(port, story, { ...carouselOpts, layout: 'breaking', posy: carouselOpts.posy }), i + 1);
        const name = `slide-${i + 2}.png`;
        await writeFile(join(OUT_DIR, dir, name), slide.png);
        slides.push({ file: name, kind: 'story', story, ...slide });
      }

      for (const s of slides) {
        console.log(`rendered ${label ? label + '/' : ''}${s.file}  ${s.dims.w}x${s.dims.h}`
          + `  ${(s.png.length / 1024).toFixed(0)} KB`
          + (s.fontsOk === false ? '  !! WEB FONTS DID NOT LOAD' : '')
          + (s.jsErrors.length ? `  (page errors: ${s.jsErrors.join(' | ')})` : ''));
        if (s.fontsOk === false) fontWarnings++;
      }

      const entry = {
        kind: 'carousel',
        headline: `${stories.length} stories`,
        images: slides.map(s => rel(s.file)),
        image: rel('slide-1.png'),                  // the cover, for previews
        width: slides[0].dims.w, height: slides[0].dims.h,
        sourceNames: [...new Set(stories.flatMap(s => s.sourceNames))],
        stories,
        usable: true,
      };

      // A news account that publishes images without alt text shuts blind
      // readers out of the news. Written to a file beside the slides, in
      // slide order, so it reaches the publisher without going through a
      // shell — the same reason the correction comment is a file.
      entry.alts = altForEntry(entry);
      await writeFile(join(OUT_DIR, dir, 'alt.json'),
                      JSON.stringify(entry.alts, null, 2) + '\n', 'utf8');
      entry.altFile = rel('alt.json');
      return entry;
    };

    /* A post per section. Top stories first, so it is always output[0] and
       everything that reads output[0] keeps working unchanged. */
    if (opts.sections) {
      const sections = (shortlist.sections || []).filter(s => s.stories?.some(x => x.usable));
      if (!sections.length) throw new Error('no usable headlines in any section');

      for (const section of sections) {
        const stories = section.stories.filter(s => s.usable);
        console.log(`\n── ${section.label} (${stories.length}) ──`);
        const entry = await renderCarousel(
          stories,
          { ...opts, label: section.label },
          section.id,
          section.id);
        rendered.push({ ...entry, section: section.id, sectionLabel: section.label });
      }
    }

    else if (opts.carousel) {
      if (!usable.length) throw new Error('no usable headlines for a carousel');
      rendered.push(await renderCarousel(usable, opts, '', ''));
    }

    else if (opts.digest) {
      if (!usable.length) throw new Error('no usable headlines to put in a digest');
      const { png, dims, fontsOk, jsErrors } = await renderUrl(digestUrl(port, usable, opts), 0);
      await writeFile(join(OUT_DIR, 'digest.png'), png);
      console.log(`rendered digest.png  ${dims.w}x${dims.h}  ${(png.length / 1024).toFixed(0)} KB`
        + (fontsOk === false ? '  !! WEB FONTS DID NOT LOAD' : '')
        + (jsErrors.length ? `  (page errors: ${jsErrors.join(' | ')})` : ''));
      if (fontsOk === false) fontWarnings++;
      rendered.push({
        kind: 'digest',
        headline: `${usable.length} stories`,
        caption: usable.map(s => '• ' + (s.display || s.headline)).join('\n'),
        sourceNames: [...new Set(usable.flatMap(s => s.sourceNames))],
        stories: usable,
        image: 'data/pending/digest.png', width: dims.w, height: dims.h, usable: true,
      });
    }

    const singleCards = (opts.digest || opts.carousel || opts.sections) ? [] : shortlist.stories;
    for (const [i, story] of singleCards.entries()) {
      if (!story.usable) { console.log(`skipped (headline too short): ${story.headline}`); continue; }
      const { png, dims, fontsOk, jsErrors } = await renderUrl(storyUrl(port, story, opts), i);
      const name = `story-${i + 1}.png`;
      await writeFile(join(OUT_DIR, name), png);
      console.log(`rendered ${name}  ${dims.w}x${dims.h}  ${(png.length / 1024).toFixed(0)} KB`
        + (fontsOk === false ? '  !! WEB FONTS DID NOT LOAD — headline is in a fallback face' : '')
        + (jsErrors.length ? `  (page errors: ${jsErrors.join(' | ')})` : ''));
      if (fontsOk === false) fontWarnings++;
      const single = { ...story, image: `data/pending/${name}`, width: dims.w, height: dims.h };
      single.alts = [altForStory(story)];
      await writeFile(join(OUT_DIR, `alt-${i + 1}.json`),
                      JSON.stringify(single.alts, null, 2) + '\n', 'utf8');
      single.altFile = `data/pending/alt-${i + 1}.json`;
      rendered.push(single);
    }
  } finally {
    server.close();
  }

  if (!rendered.length) throw new Error('nothing rendered');
  // Write the output alongside the shortlist, never over it. Overwriting
  // `stories` made the render destroy its own input: a second run found the
  // previous run's output where the stories should have been.
  await writeJson(SHORTLIST, {
    ...shortlist,
    rendered: new Date().toISOString(),
    options: opts,
    output: rendered,
  });
  console.log(`\n${rendered.length} graphic(s) in ${OUT_DIR}`);
  if (fontWarnings) {
    const msg = `${fontWarnings} graphic(s) rendered WITHOUT the brand typeface — the headline `
      + `is in a fallback face. Check the machine can reach fonts.googleapis.com.`;
    // --require-fonts turns this into a failure, so CI proves the typeface
    // loads rather than printing a warning nobody reads.
    if (process.argv.includes('--require-fonts')) throw new Error(msg);
    console.log('WARNING: ' + msg);
  }
}

main().catch(err => { console.error('render failed:', err.message); process.exit(1); });
