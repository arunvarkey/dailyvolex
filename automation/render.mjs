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
import { findImage, downloadImage } from './lib/imagery.mjs';

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

/* Try for a photograph; fall back to the generated chart. Never let this stop
   a run — a post with a chart behind it is fine, a failed run is not. */
const usedPhotos = new Set();       // one picture must not appear twice in a post

async function imageFor(story, index, opts) {
  if (opts.noPhotos) return null;
  const found = await findImage(story.display || story.headline, { exclude: usedPhotos });
  if (!found.image) {
    console.log(`  no photo for "${found.query}" (${found.error}) — using the chart`);
    return null;
  }
  const name = `photo-${index}.jpg`;
  try {
    const { bytes } = await downloadImage(found.image.url, join(OUT_DIR, name));
    usedPhotos.add(found.image.url);
    console.log(`  photo: ${found.query} · ${found.image.credit} · ${(bytes/1024).toFixed(0)} KB`);
    return { path: `data/pending/${name}`, credit: found.image.credit,
             license: found.image.license, pageUrl: found.image.pageUrl, query: found.query };
  } catch (e) {
    console.log(`  photo download failed (${e.message}) — using the chart`);
    return null;
  }
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
    bg: opts.bg,
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
    ticker: arg('ticker', 'DAILYVOLEX  ···  CRYPTO & FINANCE NEWS  ···  '),
    label:  arg('label', 'TOP STORIES'),
    date:   arg('date', today),
    digest: process.argv.includes('--digest'),
    // A carousel is the strongest format for a daily news post: the cover
    // earns the tap, each story gets a readable card of its own, and people
    // save and share multi-slide posts far more than single images.
    carousel: process.argv.includes('--carousel'),
    // Lifts the headline block off the bottom edge. Without it the card is
    // weighted right at the base of an otherwise empty frame.
    // With a chart behind the text the frame is full, so the headline sits in
    // its normal place rather than being lifted to fill emptiness.
    posy: arg('posy', '0'),
    bg:   arg('bg', 'chart'),
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

    if (opts.carousel) {
      if (!usable.length) throw new Error('no usable headlines for a carousel');

      const slides = [];
      // Slide 1: the cover, listing everything inside.
      const cover = await renderUrl(digestUrl(port, usable, opts), 0);
      await writeFile(join(OUT_DIR, 'slide-1.png'), cover.png);
      slides.push({ file: 'slide-1.png', kind: 'cover', ...cover });

      // Then one card per story, each with its own photograph where one can
      // be used legally.
      for (const [i, story] of usable.entries()) {
        story.photo = await imageFor(story, i + 2, opts);
        const slide = await renderUrl(
          storyUrl(port, story, { ...opts, layout: 'breaking', posy: opts.posy }), i + 1);
        const name = `slide-${i + 2}.png`;
        await writeFile(join(OUT_DIR, name), slide.png);
        slides.push({ file: name, kind: 'story', story, ...slide });
      }

      for (const s of slides) {
        console.log(`rendered ${s.file}  ${s.dims.w}x${s.dims.h}  ${(s.png.length / 1024).toFixed(0)} KB`
          + (s.fontsOk === false ? '  !! WEB FONTS DID NOT LOAD' : '')
          + (s.jsErrors.length ? `  (page errors: ${s.jsErrors.join(' | ')})` : ''));
        if (s.fontsOk === false) fontWarnings++;
      }

      rendered.push({
        kind: 'carousel',
        headline: `${usable.length} stories`,
        images: slides.map(s => `data/pending/${s.file}`),
        image: 'data/pending/slide-1.png',          // the cover, for previews
        width: slides[0].dims.w, height: slides[0].dims.h,
        sourceNames: [...new Set(usable.flatMap(s => s.sourceNames))],
        stories: usable,
        usable: true,
      });
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

    for (const [i, story] of ((opts.digest || opts.carousel) ? [] : shortlist.stories).entries()) {
      if (!story.usable) { console.log(`skipped (headline too short): ${story.headline}`); continue; }
      const { png, dims, fontsOk, jsErrors } = await renderUrl(storyUrl(port, story, opts), i);
      const name = `story-${i + 1}.png`;
      await writeFile(join(OUT_DIR, name), png);
      console.log(`rendered ${name}  ${dims.w}x${dims.h}  ${(png.length / 1024).toFixed(0)} KB`
        + (fontsOk === false ? '  !! WEB FONTS DID NOT LOAD — headline is in a fallback face' : '')
        + (jsErrors.length ? `  (page errors: ${jsErrors.join(' | ')})` : ''));
      if (fontsOk === false) fontWarnings++;
      rendered.push({ ...story, image: `data/pending/${name}`, width: dims.w, height: dims.h });
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
