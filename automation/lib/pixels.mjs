/* How big a picture actually is, read from its first few bytes.
 *
 * A card is 1080 pixels wide. A 320-pixel thumbnail blown up to fill it is
 * soft, blocky and obviously stretched — and the channel was publishing them,
 * because the only size test anywhere was a byte count, and a small picture of
 * a busy scene weighs more than a large one of a clear sky. "Over 12 KB"
 * catches a masthead; it does not catch a thumbnail.
 *
 * No decoder and no dependency: every one of these formats states its size in
 * a header near the front of the file, so a few hundred bytes answer it.
 *
 * Pure. Bytes in, {width, height} or null out.
 */

/* JPEG: a chain of markers. The frame header (SOFn) carries the size, and
   everything before it has to be stepped over by its own declared length.
   SOF4/SOF8/SOF12 are not frame headers — DHT, JPG and DAC share the range. */
function jpegSize(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }            // resync over padding
    const marker = b[i + 1];
    if (marker === 0xFF) { i++; continue; }
    // Standalone markers carry no length.
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    // Start of scan: the entropy-coded data begins and there is no header left.
    if (marker === 0xDA || marker === 0xD9) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isFrame = (marker >= 0xC0 && marker <= 0xCF)
      && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isFrame) {
      if (i + 9 >= b.length) return null;
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

/* PNG: the IHDR chunk is always first, at a fixed offset. */
function pngSize(b) {
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504E47 || b.readUInt32BE(4) !== 0x0D0A1A0A) return null;
  if (b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

/* WebP comes in three shapes and they each put the size somewhere else. */
function webpSize(b) {
  if (b.length < 30) return null;
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    // Lossy: a 3-byte start code, then 14 bits of width and 14 of height.
    if (b[23] !== 0x9D || b[24] !== 0x01 || b[25] !== 0x2A) return null;
    return { width: b.readUInt16LE(26) & 0x3FFF, height: b.readUInt16LE(28) & 0x3FFF };
  }
  if (chunk === 'VP8L') {
    // Lossless: 14 bits each, packed across four bytes after the signature.
    if (b[20] !== 0x2F) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
  }
  if (chunk === 'VP8X') {
    // Extended: the canvas size, as two 24-bit little-endian values minus one.
    const w = b[24] | (b[25] << 8) | (b[26] << 16);
    const h = b[27] | (b[28] << 8) | (b[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

function gifSize(b) {
  if (b.length < 10 || b.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

/* The picture's size, or null when the bytes do not say. Null is "unknown",
   never "too small": refusing a picture because its header was unfamiliar
   would quietly cost stories their photograph. */
export function pixelSize(bytes) {
  if (!bytes || bytes.length < 10) return null;
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  for (const read of [jpegSize, pngSize, webpSize, gifSize]) {
    let size = null;
    try { size = read(b); } catch { size = null; }
    if (size && size.width > 0 && size.height > 0) return size;
  }
  return null;
}

/* The card is 1080 wide and 1350 or 1920 tall. Below this a picture is being
   stretched rather than cropped, and it shows. */
export const MIN_EDGE = 800;

/* Why this picture is not good enough, or null if it is.
 *
 * Only ever a reason to try the NEXT candidate — the outlets usually name
 * several sizes of the same photograph, and the big one is often one URL
 * away. A story with a small picture is still better than a story with none,
 * so the caller keeps the best it saw and uses it if nothing beats it. */
export function tooSmall(size, { minEdge = MIN_EDGE } = {}) {
  if (!size) return null;                       // unknown is not small
  const long = Math.max(size.width, size.height);
  if (long < minEdge)
    return `only ${size.width}×${size.height} — it would be stretched to fill the card`;
  return null;
}
