/* How long each card stays on screen, and the ffmpeg call that makes the file.
 *
 * A Reel reaches people a carousel never will, and it costs nothing but the
 * encode. What it cannot do is carry alt text — Instagram takes `alt_text`
 * only on image containers — so the Reel is never a replacement for the
 * carousel, only an extra way in. The caption carries every headline for the
 * same reason.
 *
 * The pacing is the whole craft here. A card held too briefly is a card nobody
 * read, and a long headline needs longer than a short one, so the time on
 * screen is computed from the words rather than fixed. Nothing is written or
 * rephrased to fit a duration: the cards are the stills the carousel already
 * uses, re-rendered upright.
 *
 * This file touches no disk and spawns nothing. It decides timings and builds
 * an argv array, so the arithmetic that would otherwise only be checkable by
 * watching a video is checkable by a test.
 */

/* Instagram's bounds for a Reel published through the API. The floor is the
   real one — a two-second video is rejected outright. The ceiling is the
   lowest figure Meta's own guidance has used for API Reels; staying under it
   costs nothing and a rejection after the encode costs the whole post. */
export const MIN_SECONDS = 3;
export const MAX_SECONDS = 90;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round1 = n => Math.round(n * 10) / 10;

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/* A story card: the headline, the outlet and — on a stat card — a figure.
   3.4s is about as short as a card can be and still be read; 0.11s a word is
   roughly 160 words a minute, slower than silent reading because the reader
   is also deciding whether to keep watching. */
export function secondsForStory(story) {
  const words = wordCount(story?.display || story?.headline);
  return round1(clamp(3.4 + words * 0.11, 3.4, 6.5));
}

/* The cover lists every headline in the post, so it scales with how many. */
export function secondsForCover(count) {
  return round1(clamp(1.8 + count * 0.9, 2.6, 6));
}

/* The closing card is four short lines and a handle. */
/* Shorter than it was. It is the only card in the reel carrying no news, and
   on a fourteen-second video three seconds of it is a fifth of the running
   time. Long enough to read four short lines and a handle. */
export const SECONDS_FOR_CLOSING = 2.5;

/* Frame-by-frame timings for one section's reel.
 *
 * `specs` are the composed cards, each carrying what kind of card it is. It
 * used to work the kind out from the position — first is a cover, last is
 * the closing card — which was guesswork that happened to be right, and
 * stopped being right the moment the reel dropped its cover. The composer
 * already knows; it just was not being asked.
 */
export function reelTimings(frames, specs = []) {
  if (!frames?.length) throw new Error('a reel needs at least one frame');
  if (specs.length && specs.length !== frames.length)
    throw new Error(`${frames.length} frames but ${specs.length} cards — they must match`);

  return frames.map((file, i) => {
    const spec = specs[i] || {};
    if (spec.kind === 'closing') return { file, seconds: SECONDS_FOR_CLOSING, kind: 'closing' };
    if (spec.kind === 'cover')
      return { file, seconds: secondsForCover(specs.filter(x => x.kind === 'story').length),
               kind: 'cover' };
    return { file, seconds: secondsForStory(spec.story), kind: 'story' };
  });
}

/* What the finished video will run to, once the crossfades have eaten their
   overlap. Each transition costs its own duration, because the two cards are
   on screen together for it. */
export function totalSeconds(timings, fade) {
  const sum = timings.reduce((n, t) => n + t.seconds, 0);
  // Exact, and rounded only where it is printed. Rounding here could round
  // UP past where the crossfade chain actually ends — 14.25 became 14.3 —
  // so `-t` asked ffmpeg for a twentieth of a second of video that does not
  // exist. Harmless in the file and wrong in the arithmetic, which is the
  // kind of wrong that becomes harmful later.
  return sum - Math.max(0, timings.length - 1) * fade;
}

/* Refuse before the encode rather than after Instagram does. */
export function checkDuration(seconds) {
  if (seconds < MIN_SECONDS)
    return `the reel would run ${seconds}s — Instagram refuses anything under ${MIN_SECONDS}s`;
  if (seconds > MAX_SECONDS)
    return `the reel would run ${seconds}s — over Instagram's ${MAX_SECONDS}s limit for an API reel`;
  return null;
}

/* The ffmpeg command, as an argv array so it never passes through a shell.
 *
 * Each still is held for its own time, drifting very slightly inward, and
 * crossfaded into the next. The drift goes from 1.06 down to 1.01 — a card
 * settling rather than looming — which also means the frame a reader is
 * looking at longest is the least scaled, so the headline stays sharp. Cards
 * are mostly type, and type that shimmers is type nobody reads.
 */
export function ffmpegArgs(timings, {
  out,
  fps = 30,
  width = 1080,
  height = 1920,
  fade = 0.45,
  zoomFrom = 1.06,
  zoomTo = 1.01,
  // Measured, not guessed. At 1080x1920 for eighteen seconds: crf 23 gives
  // 2.9 MB, crf 26 gives 1.9 MB, and Instagram re-encodes whatever arrives,
  // so the third is spent on nothing a viewer sees. A megabyte a day is also
  // a megabyte of git history every day, forever.
  crf = 26,
} = {}) {
  if (!out) throw new Error('ffmpegArgs needs an output path');
  if (!timings?.length) throw new Error('ffmpegArgs needs at least one frame');

  const total = totalSeconds(timings, fade);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];

  /* `-framerate` is not optional and not cosmetic. The image demuxer loops a
     still at 25fps whatever the output rate is, so without it every card
     arrived with seconds × 25 frames, zoompan re-stamped them at the output
     rate, and each clip came out five sixths of its intended length. The
     crossfade offsets — computed in seconds — then fell past the end of the
     first clip, and ffmpeg exited 0 having written a 3.8-second video of one
     card. Nothing failed; the file was simply wrong, and the duration in its
     container header was the silent audio track's. */
  for (const t of timings)
    args.push('-loop', '1', '-framerate', String(fps), '-t', String(t.seconds), '-i', t.file);

  // A Reel with no audio stream at all is a file some players and some of
  // Meta's own processing treat as broken. Silence is the honest track: this
  // channel has no rights to any music, and a news card does not need any.
  args.push('-f', 'lavfi', '-t', String(total),
            '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');

  const chains = [];
  timings.forEach((t, i) => {
    const frames = Math.max(2, Math.round(t.seconds * fps));
    // `on` is the output frame number, so the drift is expressed per frame
    // rather than per second and lands exactly on zoomTo at the last one.
    const z = `${zoomFrom}-${round1((zoomFrom - zoomTo) * 1000) / 1000}*on/${frames - 1}`;
    chains.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase`
      + `,crop=${width}:${height}`
      + `,zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
      + `:d=1:s=${width}x${height}:fps=${fps}`
      + `,setsar=1[v${i}]`);
  });

  // Crossfade the cards together one at a time. Each transition starts `fade`
  // before the outgoing card's time is up, which is what makes the overlap.
  let last = 'v0';
  let offset = 0;
  for (let i = 1; i < timings.length; i++) {
    // Exact, and rounded only for the string. Rounding the running total at
    // each step pushed every transition up to half a frame late and the drift
    // accumulated, so by the last card the chain ended a tenth of a second
    // before the duration the cards add up to.
    offset += timings[i - 1].seconds - fade;
    const label = `x${i}`;
    chains.push(`[${last}][v${i}]xfade=transition=fade:duration=${fade}`
      + `:offset=${Math.round(offset * 1000) / 1000}[${label}]`);
    last = label;
  }
  chains.push(`[${last}]format=yuv420p[vout]`);

  args.push('-filter_complex', chains.join(';'));
  args.push(
    '-map', '[vout]', '-map', `${timings.length}:a`,
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1',
    '-preset', 'medium', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-t', String(total), '-movflags', '+faststart',
    out);
  return args;
}
