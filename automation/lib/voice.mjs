/* What the reel says out loud.
 *
 * A reel of still cards crossfading is a slideshow. A voice reading the news
 * over footage is a bulletin, and that is the difference the owner asked for.
 *
 * The rule that does not bend here either: every spoken word was published by
 * an outlet. The script is the headline, then the outlet's own opening
 * sentence from the feed summary, then who reported it. Nothing is written to
 * join them up, nothing is characterised, and nothing is explained in words
 * this channel invented — a synthetic voice saying something no newsroom said
 * is the same invention as printing it, and harder to catch because it is
 * gone in a second.
 *
 * Splitting the script from the speaking is deliberate: what gets said is
 * checkable in a test, and only the saying needs a binary.
 */

/* Feed summaries arrive as HTML with the outlet's own furniture in them. */
export function plainText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&hellip;/g, '…').replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* The first whole sentence, and only if it is one.
 *
 * A feed summary is often a teaser that trails off, or the first clause of
 * the standfirst, or the headline again. A half sentence read aloud sounds
 * like a fault, so anything that does not end in a full stop is left out
 * rather than tidied into sounding finished. */
export function firstSentence(text, { min = 40, max = 240 } = {}) {
  const t = plainText(text);
  if (!t) return '';
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/);
  if (!m) return '';
  const s = m[1].trim();
  if (s.length < min || s.length > max) return '';
  // A sentence ending in an ellipsis is a teaser, not a sentence.
  if (/[…]$|\.\.\.$/.test(s)) return '';
  return s;
}

/* Read as a presenter would: the outlets separated by "and" rather than by a
   middle dot, which a speech engine reads as nothing at all. */
export function sourceLine(source) {
  const names = String(source || '').split('·').map(s => s.trim()).filter(Boolean);
  if (!names.length) return '';
  if (names.length === 1) return `Reported by ${names[0]}.`;
  return `Reported by ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}.`;
}

/* The whole script, in the order it is spoken. */
export function scriptFor(story, { handle = 'Daily Volex' } = {}) {
  const headline = String(story?.display || story?.headline || '').trim();
  if (!headline) return { lines: [], text: '' };

  const lines = [`${handle}.`, headline.replace(/\s*[—–-]\s*$/, '') + '.'];

  // The outlet's own sentence, if it published one worth reading.
  const detail = firstSentence(story?.summary);
  // Not when it merely repeats the headline back — a voice saying the same
  // thing twice sounds broken.
  if (detail && !sameThing(detail, headline)) lines.push(detail);

  const credit = sourceLine(story?.source);
  if (credit) lines.push(credit);

  return { lines, text: lines.join(' ') };
}

/* Two strings saying the same thing, for the purpose of not saying it twice. */
export function sameThing(a, b) {
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const A = new Set(norm(a).split(' ').filter(w => w.length > 3));
  const B = new Set(norm(b).split(' ').filter(w => w.length > 3));
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size) > 0.7;
}

/* Roughly how long the script takes to read, for pacing the pictures to it.
   A news read is about 165 words a minute. */
export function spokenSeconds(text, { wordsPerMinute = 165 } = {}) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  return Math.round((words / wordsPerMinute) * 60 * 10) / 10;
}

/* The argv for a speech engine. Two are supported and they are not equal:
   piper is a neural voice and sounds like one, espeak-ng is offline,
   instant, and sounds like a screen reader from 1995. espeak is the
   fallback so that a reel still speaks when the model cannot be fetched. */
export function speakArgs(engine, { text, out, model, voice = 'en-gb', rate = 150 }) {
  if (engine === 'piper') {
    if (!model) throw new Error('piper needs a voice model');
    return { cmd: 'piper', args: ['-m', model, '-f', out], stdin: text };
  }
  return { cmd: 'espeak-ng',
           args: ['-v', voice, '-s', String(rate), '-w', out, text],
           stdin: null };
}
