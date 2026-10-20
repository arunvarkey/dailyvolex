#!/usr/bin/env node
/* Stage 2b — turn one section's cards into a Reel.
 *
 * A Reel is shown to people who do not follow the account; a carousel is
 * mostly shown to people who already do. That is the whole reason this exists.
 *
 * What a Reel cannot do is carry a description for a blind reader: Instagram
 * takes `alt_text` when an image container is made, and a Reel is not an image
 * container. So the Reel is never a replacement for the carousel — the
 * carousel stays the post of record, with a description on every slide, and
 * the Reel's caption carries every headline in full so that a reader using a
 * screen reader still gets the news rather than "video".
 *
 * The cards are the same cards. They are re-rendered upright at 1080x1920
 * because the app lays a card out for the frame it is given, and a 4:5 card
 * letterboxed into 9:16 is two black bars and a smaller headline. No new
 * words are introduced anywhere: the photographs are the ones already found
 * and downloaded, so this stage makes no image-search calls at all.
 *
 *   node automation/reel.mjs [--section top] [--fade 0.45] [--fps 30]
 *
 * Writes data/pending/<section>/reel.mp4 and records it in the shortlist.
 * Never required: a day with no Reel is a day with a carousel, which is the
 * post that matters. The workflow runs this with continue-on-error for that
 * reason.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readJson, writeJson } from './lib/store.mjs';
import { serve, renderUrl, digestUrl, closingUrl, storyUrl } from './render.mjs';
import { reelTimings, totalSeconds, checkDuration, ffmpegArgs, MIN_SECONDS } from './lib/reelplan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHORTLIST = join(ROOT, 'data', 'shortlist.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.stdout.on('data', () => {});
    p.on('error', e => reject(new Error(`${cmd} could not be started: ${e.message}`)));
    p.on('close', code => code === 0
      ? resolve()
      : reject(new Error(`${cmd} exited ${code}${err ? `: ${err.trim().split('\n').slice(-4).join(' | ')}` : ''}`)));
  });
}

/* Read back what was actually written, rather than what was asked for. An
   encode that silently produced 1080x1350, or no audio track, would be
   rejected by Instagram after the approval — which is the worst place to find
   out.
 *
 * The VIDEO stream's own duration, specifically. The container's duration is
 * the longest stream in it, so a 3.8-second video with a 19-second silent
 * audio track reports as nineteen seconds — which is exactly what the first
 * working version of this did, and the reason this reads the stream. */
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json',
    '-count_frames', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams || []).find(s => s.codec_type === 'video');
    const a = (j.streams || []).find(s => s.codec_type === 'audio');
    const round1 = n => Math.round(Number(n || 0) * 10) / 10;
    return {
      width: v?.width, height: v?.height, vcodec: v?.codec_name, pix: v?.pix_fmt,
      frames: Number(v?.nb_read_frames || 0),
      acodec: a?.codec_name,
      seconds: round1(v?.duration),
      audioSeconds: round1(a?.duration),
      containerSeconds: round1(j.format?.duration),
    };
  } catch { return null; }
}

async function main() {
  const shortlist = await readJson(SHORTLIST, null);
  const out = shortlist?.output;
  if (!out?.length) throw new Error('nothing rendered yet — run render.mjs first');

  const wanted = arg('section', 'top');
  const entry = out.find(e => e.section === wanted) || (out.length === 1 ? out[0] : null);
  if (!entry) throw new Error(
    `no section "${wanted}" in this post — it has ${out.map(e => e.section || 'post').join(', ')}`);

  const stories = (entry.stories || []).filter(s => s.usable !== false);
  if (!stories.length) throw new Error('that section has no stories to put in a reel');

  if (spawnSync('ffmpeg', ['-version']).status !== 0)
    throw new Error('ffmpeg is not installed — a reel cannot be encoded without it');

  const fps  = Math.max(23, Math.min(60, parseInt(arg('fps', '30'), 10) || 30));
  const fade = Math.max(0, Math.min(1, Number(arg('fade', '0.45')) || 0.45));

  /* The same card options the carousel was rendered with, upright. Reading
     them back from the shortlist rather than re-deriving defaults means the
     reel cannot quietly use a different theme or ticker from the post it
     belongs to. */
  const opts = { ...(shortlist.options || {}), ratio: '9:16',
                 label: entry.sectionLabel || 'TOP STORIES' };

  // Frames live outside data/, so a run cannot commit eight megabytes of PNG
  // alongside the one file that is actually needed.
  const work = await mkdtemp(join(tmpdir(), 'dv-reel-'));
  const { server, port } = await serve(ROOT);
  const frames = [];
  try {
    const shoot = async (url, n) => {
      const { png, dims } = await renderUrl(url, n);
      if (dims.w !== 1080 || dims.h !== 1920)
        throw new Error(`a reel frame came out ${dims.w}x${dims.h}, not 1080x1920`);
      const file = join(work, `frame-${String(n + 1).padStart(2, '0')}.png`);
      await writeFile(file, png);
      frames.push(file);
    };

    await shoot(digestUrl(port, stories, opts), 0);
    for (const [i, story] of stories.entries())
      await shoot(storyUrl(port, story, { ...opts, layout: 'breaking' }), i + 1);
    await shoot(closingUrl(port, opts), stories.length + 1);
  } finally {
    server.close();
  }

  const timings = reelTimings(frames, stories);
  const seconds = totalSeconds(timings, fade);
  const refusal = checkDuration(seconds);
  if (refusal) { await rm(work, { recursive: true, force: true }); throw new Error(refusal); }

  for (const t of timings)
    console.log(`  ${t.kind.padEnd(8)} ${t.seconds}s`);
  console.log(`  ${timings.length} cards, ${seconds}s with ${fade}s crossfades`);

  const dir = entry.section || '';
  await mkdir(join(ROOT, 'data', 'pending', dir), { recursive: true });
  const rel = `data/pending/${dir ? dir + '/' : ''}reel.mp4`;
  const outFile = join(ROOT, rel);

  try {
    await run('ffmpeg', ffmpegArgs(timings, { out: outFile, fps, fade }));
  } finally {
    // --keep-frames leaves the stills behind to look at. They are PNGs of
    // 1080x1920, so eight megabytes of them, and they live outside data/
    // precisely so that a debugging run cannot commit them.
    if (process.argv.includes('--keep-frames')) console.log(`  frames kept in ${work}`);
    else await rm(work, { recursive: true, force: true });
  }

  const { size } = await stat(outFile);
  const made = probe(outFile);
  if (made) {
    console.log(`  ${made.width}x${made.height} ${made.vcodec}/${made.pix}`
      + ` + ${made.acodec || 'NO AUDIO'} · ${made.seconds}s video, ${made.frames} frames`);
    const wrong = [];
    if (made.width !== 1080 || made.height !== 1920) wrong.push(`${made.width}x${made.height}`);
    if (made.vcodec !== 'h264') wrong.push(`video is ${made.vcodec}`);
    if (made.pix !== 'yuv420p') wrong.push(`pixel format is ${made.pix}`);
    if (!made.acodec) wrong.push('no audio track');
    // The one that matters most, because nothing else about the file looks
    // wrong when it happens: the cards did not all make it in.
    if (Math.abs(made.seconds - seconds) > 0.3)
      wrong.push(`the video runs ${made.seconds}s, not the ${seconds}s the cards add up to`);
    if (made.seconds < MIN_SECONDS) wrong.push(`under Instagram's ${MIN_SECONDS}s floor`);
    if (wrong.length) throw new Error(`the reel is not in a shape Instagram accepts: ${wrong.join(', ')}`);
  } else {
    console.log('  WARNING: ffprobe is not available, so the file could not be checked');
  }

  entry.reel = {
    file: rel,
    cover: entry.image || null,       // the carousel cover, as the thumbnail
    seconds: made?.seconds ?? seconds,
    width: 1080, height: 1920,
    bytes: size,
    // Said out loud in the data, not only in a comment: whoever reads this
    // record later should not have to work out why the reel has no alts.
    alt: 'Instagram does not accept alt text on a reel; the caption carries every headline.',
    built: new Date().toISOString(),
  };
  await writeJson(SHORTLIST, shortlist);

  console.log(`\nreel: ${rel}  ${(size / 1024 / 1024).toFixed(2)} MB`);
}

if (process.argv[1] && process.argv[1].endsWith('reel.mjs'))
  main().catch(err => { console.error('reel failed:', err.message); process.exit(1); });
