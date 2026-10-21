#!/usr/bin/env node
/* Stage 2b — one story, moving, with a voice over it.
 *
 * A Reel is shown to people who do not follow the account; a carousel is
 * mostly shown to people who already do. That is the whole reason this
 * exists, and it is why the reel is not a condensed carousel: it carries one
 * story and says it properly.
 *
 * What it shows, best first: the video the outlet put on the article, then
 * its photograph with a slow push on it. A still that moves is not footage
 * and is not pretended to be — it is what a bulletin does when there is no
 * tape.
 *
 * What it says: the headline, the outlet's own opening sentence from the
 * feed, and who reported it. Every spoken word was published by somebody. A
 * synthetic voice saying something no newsroom said is the same invention as
 * printing it and harder to catch, because it is gone in a second.
 *
 * What it cannot do is carry a description for a blind reader — Instagram
 * takes alt_text on an image container and a reel is not one — so the reel
 * is never the only form a story is published in, and its caption carries
 * the headline in full.
 *
 *   node automation/reel.mjs [--section top] [--voice piper|espeak]
 *                            [--video <url>]   footage to use instead
 *                            [--silent]        no voiceover
 *
 * Writes <edition>/<section>/reel.mp4 and records it on the edition beside
 * the carousel. Never required: a day with no reel is a day with a carousel,
 * which is the post that matters, so the workflow runs this with
 * continue-on-error.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve, renderUrl, cardUrl } from './render.mjs';
import { composeStory, toQuery } from './lib/compose.mjs';
import { load, save, dirFor, attachPost } from './lib/edition.mjs';
import { videoFromArticle } from './lib/articlevideo.mjs';
import { scriptFor, spokenSeconds, speakArgs } from './lib/voice.mjs';
import { reelSeconds, checkDuration, ffmpegArgs, MIN_SECONDS } from './lib/reelbuild.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const FLAG = n => process.argv.includes(`--${n}`);

function run(cmd, args, { stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.stdout.on('data', () => {});
    p.on('error', e => reject(new Error(`${cmd} could not be started: ${e.message}`)));
    p.on('close', code => code === 0
      ? resolve()
      : reject(new Error(`${cmd} exited ${code}${err ? `: ${err.trim().split('\n').slice(-3).join(' | ')}` : ''}`)));
    if (stdin != null) { p.stdin.write(stdin); p.stdin.end(); }
  });
}

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json',
    '-count_frames', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams || []).find(s => s.codec_type === 'video');
    const a = (j.streams || []).find(s => s.codec_type === 'audio');
    const round1 = n => Math.round(Number(n || 0) * 10) / 10;
    return { width: v?.width, height: v?.height, vcodec: v?.codec_name, pix: v?.pix_fmt,
             frames: Number(v?.nb_read_frames || 0), acodec: a?.codec_name,
             seconds: round1(v?.duration), audioSeconds: round1(a?.duration) };
  } catch { return null; }
}

const seconds = file => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  return r.status === 0 ? Number(String(r.stdout).trim()) || 0 : 0;
};

/* Fetch footage. A direct file is downloaded; anything else is handed to
   yt-dlp, which resolves the page to a stream. Never fatal: no footage means
   the photograph moves instead. */
async function getFootage(url, out) {
  if (!url) return null;
  const direct = /\.(mp4|m4v|mov|webm)(\?|$)/i.test(url);
  try {
    if (direct) {
      const res = await fetch(url, {
        headers: { 'user-agent': 'DailyVolex/1.0 (+https://github.com/arunvarkey/dailyvolex)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 50_000) throw new Error(`only ${(buf.length / 1024).toFixed(0)} KB`);
      await writeFile(out, buf);
      return out;
    }
    if (spawnSync('yt-dlp', ['--version']).status !== 0)
      throw new Error('yt-dlp is not installed, and this link is not a direct file');
    // Smallest acceptable rendition: it is going to be cropped to 1080 wide
    // and re-encoded, so a 4K master is time spent on nothing.
    await run('yt-dlp', ['-f', 'bv*[height<=1280]+ba/b[height<=1280]/b',
                         '--no-playlist', '--no-warnings', '-o', out, url]);
    return out;
  } catch (e) {
    console.log(`  no footage: ${e.message}`);
    return null;
  }
}

async function main() {
  const edition = await load(ROOT, arg('edition'));
  const wanted = arg('section', 'top');
  const section = edition.sections.find(s => s.id === wanted)
    || (edition.sections.length === 1 ? edition.sections[0] : null);
  if (!section) throw new Error(
    `no section "${wanted}" in this edition — it has ${edition.sections.map(s => s.id).join(', ')}`);

  const carousel = (section.posts || []).find(p => p.kind === 'carousel');
  if (!carousel) throw new Error(`${section.label} has not been rendered yet`);

  /* One story. The lead one, in the editorial order the section already
     decided — the reel opens on the news rather than on a contents page. */
  const story = section.stories.filter(s => s.usable !== false)[0];
  if (!story) throw new Error('that section has no story to make a reel of');
  console.log(`  story: ${story.display || story.headline}`);

  if (spawnSync('ffmpeg', ['-version']).status !== 0)
    throw new Error('ffmpeg is not installed — a reel cannot be encoded without it');

  const fps = Math.max(23, Math.min(60, parseInt(arg('fps', '30'), 10) || 30));
  const work = await mkdtemp(join(tmpdir(), 'dv-reel-'));

  try {
    /* ── What it says ─────────────────────────────────────────── */
    const script = scriptFor(story);
    let voiceFile = null;
    if (!FLAG('silent') && script.text) {
      const engine = arg('voice', process.env.PIPER_MODEL ? 'piper' : 'espeak');
      const out = join(work, 'voice.wav');
      try {
        const { cmd, args, stdin } = speakArgs(engine, {
          text: script.text, out, model: process.env.PIPER_MODEL,
        });
        await run(cmd, args, { stdin });
        voiceFile = out;
        console.log(`  voice: ${engine}, ${seconds(out).toFixed(1)}s`
          + ` (${script.lines.length} lines, estimated ${spokenSeconds(script.text)}s)`);
      } catch (e) {
        // A reel with no voice is still a reel. A run that dies because a
        // speech engine is missing is a run with no post.
        console.log(`  no voice: ${e.message}`);
      }
    }
    for (const line of script.lines) console.log(`    "${line}"`);

    const spoken = voiceFile ? seconds(voiceFile) : spokenSeconds(script.text);
    const total = reelSeconds(spoken);
    const refusal = checkDuration(total);
    if (refusal) throw new Error(refusal);

    /* ── What it shows ────────────────────────────────────────── */
    let footage = null;
    const given = arg('video');
    if (given) {
      console.log(`  footage: the link you gave me`);
      footage = await getFootage(given, join(work, 'footage.mp4'));
    } else if (!FLAG('no-footage')) {
      const found = await videoFromArticle(story.link, { source: story.source });
      if (found.video) {
        console.log(`  footage: ${found.video.credit || found.video.url.slice(0, 60)}`);
        footage = await getFootage(found.video.url, join(work, 'footage.mp4'));
      } else {
        console.log(`  no footage: ${found.error}`);
      }
    }

    // The photograph, when there is no tape. It is already downloaded.
    const still = !footage && story.photo?.path ? join(ROOT, story.photo.path) : null;
    if (!footage && still) console.log('  showing the photograph, pushed in slowly');
    // And when there is neither: the card itself, pushed in. Not much of a
    // reel, but a day with no reel is worse than a plain one.
    const cardOnly = !footage && !still;
    if (cardOnly) console.log('  no footage and no photograph — showing the card itself');

    /* ── The card, with nothing behind it ─────────────────────── */
    const { server, port } = await serve(ROOT);
    let overlay;
    try {
      const spec = composeStory({ ...story, photo: null }, {
        theme: arg('theme', 'bbc'), ratio: '9:16', layout: 'breaking',
        ticker: 'DAILYVOLEX  ···  TODAY’S NEWS  ···  ',
        date: new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' }),
        posy: '0', bg: 'editorial',
      });
      // Over footage or a photograph the card is drawn with nothing behind
      // it, so ffmpeg can composite it. With neither, the card IS the
      // picture and keeps its own backdrop.
      if (!cardOnly) spec.params.overlay = '1';
      const { bytes, dims } = await renderUrl(cardUrl(port, spec), 0, { quality: 0 });
      if (dims.w !== 1080 || dims.h !== 1920)
        throw new Error(`the card came out ${dims.w}x${dims.h}, not 1080x1920`);
      overlay = join(work, 'card.png');
      await writeFile(overlay, bytes);
    } finally {
      server.close();
    }

    /* ── Put it together ──────────────────────────────────────── */
    const rel = `${dirFor(edition.id)}/${section.id}/reel.mp4`;
    const outFile = join(ROOT, rel);
    await mkdir(dirname(outFile), { recursive: true });

    await run('ffmpeg', ffmpegArgs({
      visual: footage || still || overlay,
      overlay: cardOnly ? null : overlay,
      voice: voiceFile,
      out: outFile, seconds: total, hasFootage: !!footage, fps,
    }));

    const { size } = await stat(outFile);
    const made = probe(outFile);
    if (made) {
      console.log(`  ${made.width}x${made.height} ${made.vcodec}/${made.pix}`
        + ` + ${made.acodec || 'NO AUDIO'} · ${made.seconds}s`);
      const wrong = [];
      if (made.width !== 1080 || made.height !== 1920) wrong.push(`${made.width}x${made.height}`);
      if (made.vcodec !== 'h264') wrong.push(`video is ${made.vcodec}`);
      if (made.pix !== 'yuv420p') wrong.push(`pixel format is ${made.pix}`);
      if (!made.acodec) wrong.push('no audio track');
      if (Math.abs(made.seconds - total) > 0.3)
        wrong.push(`the video runs ${made.seconds}s, not the ${total}s it was built for`);
      if (made.seconds < MIN_SECONDS) wrong.push(`under Instagram's ${MIN_SECONDS}s floor`);
      if (wrong.length) throw new Error(`the reel is not in a shape Instagram accepts: ${wrong.join(', ')}`);
    }

    attachPost(edition, section.id, {
      kind: 'reel',
      id: `${section.id}-reel`,
      files: [rel],
      cover: carousel.cover,
      caption: carousel.caption,
      alts: '',
      noAlts: 'Instagram does not accept alt text on a reel; the caption carries the headline.',
      seconds: made?.seconds ?? total,
      bytes: size,
      // What it is made of, so the approval issue and the record can say so.
      story: story.display || story.headline,
      footage: footage ? 'the outlet’s video' : 'the photograph, pushed in',
      spoken: voiceFile ? script.text : null,
    });
    await save(ROOT, edition);

    console.log(`\nreel: ${rel}  ${(size / 1024 / 1024).toFixed(2)} MB  ${total}s`);
  } finally {
    if (FLAG('keep-work')) console.log(`  working files kept in ${work}`);
    else await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith('reel.mjs'))
  main().catch(err => { console.error('reel failed:', err.message); process.exit(1); });
