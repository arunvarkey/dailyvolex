/* One story, moving, with a voice over it.
 *
 * The old reel was three still cards crossfading and a silent audio track —
 * a slideshow with a soundtrack of nothing. This builds the other thing: a
 * single story, the outlet's own footage where there is any and its
 * photograph moving where there is not, the card composited over the top,
 * and a voice reading what was published.
 *
 * The length is the voice's length. A bulletin runs as long as it takes to
 * say the thing and then stops, rather than holding a card for a number
 * somebody picked.
 *
 * Pure: it decides timings and builds an argv array, so the arithmetic that
 * would otherwise only be checkable by watching a video is checkable by a
 * test.
 */

export const MIN_SECONDS = 3;
export const MAX_SECONDS = 90;

const round1 = n => Math.round(n * 10) / 10;

/* How long the finished reel runs.
 *
 * The voice sets it: a beat before it starts so the first frame is seen
 * rather than talked over, and a beat after it ends so it does not cut on
 * the last syllable. Clamped into what Instagram takes. */
export function reelSeconds(spokenSeconds, { lead = 0.6, tail = 1.2 } = {}) {
  const total = (Number(spokenSeconds) || 0) + lead + tail;
  return round1(Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, total)));
}

export function checkDuration(seconds) {
  if (seconds < MIN_SECONDS)
    return `the reel would run ${seconds}s — Instagram refuses anything under ${MIN_SECONDS}s`;
  if (seconds > MAX_SECONDS)
    return `the reel would run ${seconds}s — over Instagram's ${MAX_SECONDS}s limit for an API reel`;
  return null;
}

/* The video side of the filter graph.
 *
 * Footage is filled to the frame and cropped, never letterboxed: black bars
 * on a Reel read as a repost of somebody else's landscape video, which is
 * what they are. A still is pushed in slowly instead — the documentary move,
 * and the only honest way to make a photograph move.
 */
function visualChain({ hasFootage, seconds, fps, width, height, zoomFrom, zoomTo }) {
  if (hasFootage) {
    return [
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase`
      + `,crop=${width}:${height}`
      // Graded down a little so white type holds against whatever the
      // footage is doing underneath it.
      + `,eq=brightness=-0.06:saturation=0.95`
      + `,fps=${fps},setsar=1,trim=duration=${seconds},setpts=PTS-STARTPTS[bg]`,
    ];
  }
  const frames = Math.max(2, Math.round(seconds * fps));
  const span = round1((zoomFrom - zoomTo) * 1000) / 1000;
  return [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase`
    + `,crop=${width}:${height}`
    + `,zoompan=z='${zoomFrom}-${span}*on/${frames - 1}'`
    + `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`
    + `:d=1:s=${width}x${height}:fps=${fps}`
    + `,setsar=1[bg]`,
  ];
}

/* The whole command.
 *
 * Inputs in a fixed order so the filter graph can name them: the visual,
 * the overlay card, then the voice if there is one.
 */
export function ffmpegArgs({
  visual,            // the footage or the still
  overlay,           // the card, drawn with nothing behind it
  voice = null,      // a wav, or null for a silent reel
  out,
  seconds,
  hasFootage = false,
  fps = 30,
  width = 1080,
  height = 1920,
  zoomFrom = 1.08,
  zoomTo = 1.01,
  crf = 26,
} = {}) {
  if (!visual) throw new Error('a reel needs something to show');
  // `overlay` may be null when the visual IS the card — a day with neither
  // footage nor a photograph still gets a reel, because the alternative is
  // no reel at all.
  if (!out) throw new Error('a reel needs somewhere to go');
  if (!(seconds > 0)) throw new Error('a reel needs a length');

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];

  if (hasFootage) {
    // Loop the footage if it is shorter than the voice, rather than freezing
    // on its last frame or cutting the read short.
    args.push('-stream_loop', '-1', '-t', String(seconds), '-i', visual);
  } else {
    args.push('-loop', '1', '-framerate', String(fps), '-t', String(seconds), '-i', visual);
  }
  if (overlay)
    args.push('-loop', '1', '-framerate', String(fps), '-t', String(seconds), '-i', overlay);
  if (voice) args.push('-i', voice);

  const chains = visualChain({ hasFootage, seconds, fps, width, height, zoomFrom, zoomTo });
  if (overlay) {
    chains.push(`[1:v]scale=${width}:${height},format=rgba[card]`);
    chains.push(`[bg][card]overlay=0:0:format=auto,format=yuv420p[vout]`);
  } else {
    chains.push(`[bg]format=yuv420p[vout]`);
  }

  const voiceIn = overlay ? 2 : 1;
  if (voice) {
    /* The voice starts a beat in, so the first frame is seen before it is
       talked over, and the track is padded to the full length so the file
       does not end when the speaking does. Levelled to roughly what a
       platform expects rather than left at whatever the engine produced. */
    chains.push(`[${voiceIn}:a]adelay=600|600,loudnorm=I=-16:TP=-1.5:LRA=11,apad[aout]`);
  } else {
    args.push('-f', 'lavfi', '-t', String(seconds),
              '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
  }

  args.push('-filter_complex', chains.join(';'));
  args.push('-map', '[vout]');
  args.push('-map', voice ? '[aout]' : `${voiceIn}:a`);
  args.push(
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1',
    '-preset', 'medium', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-t', String(seconds), '-movflags', '+faststart',
    out);
  return args;
}
