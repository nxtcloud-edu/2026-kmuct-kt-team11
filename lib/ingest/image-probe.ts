/**
 * "Is this actually an image, and how big is it?" — answered from the bytes.
 *
 * Pure, synchronous, no dependencies and no I/O, so it can be run over a buffer
 * in a test as easily as over a download.
 *
 * WHY NOT TRUST `Content-Type`. A header is a claim made by the sender about
 * what it is sending. The bytes are the thing itself. We are fetching from a CDN
 * we do not control, on a URL that came out of an undocumented payload, and
 * uploading whatever comes back into a bucket that serves it to browsers under
 * our own origin — the one place where "it said it was a JPEG" is not good
 * enough. A response labelled `image/jpeg` that is actually an HTML error page
 * would otherwise be stored, served, and render as a broken card forever.
 *
 * WHY DECODE THE DIMENSIONS rather than copying the candidate's own `width` and
 * `height`. Those numbers describe the URL Instagram offered; these describe the
 * file we kept. They have agreed in every sample so far. The day they disagree
 * is the day `reels.thumb_width` is wrong, the deck reserves the wrong aspect
 * ratio, and every card in the stack jumps as its image loads — a bug that would
 * be blamed on CSS for a week.
 *
 * Only the three formats the bucket accepts are recognised. Anything else —
 * including a GIF, an SVG, an MP4 or an HTML error page — returns null and is
 * refused upstream. SVG in particular must never be accepted here: it is a
 * document, it can carry script, and it would be served from our own origin.
 */

export type ProbedImage = {
  /** The media type the BYTES say, which is what gets sent to Storage. */
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
};

export function probeImage(bytes: Uint8Array): ProbedImage | null {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length < 16) return null;

  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpeg(b);
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return png(b);
  }
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    return webp(b);
  }
  return null;
}

/**
 * Walk the marker segments to the frame header.
 *
 * The size is NOT at a fixed offset in a JPEG: EXIF, ICC profiles and comment
 * segments sit in front of it and vary in length by kilobytes, so the only way
 * to the dimensions is segment by segment. SOF0 through SOF15 all carry the same
 * header layout; C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding
 * conditioning) share the numeric range and are NOT frame headers, which is the
 * classic way to read a Huffman table as an image size.
 */
function jpeg(b: Buffer): ProbedImage | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    // Fill bytes: any number of 0xFF may precede a marker.
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i++;
      marker = b[i + 1];
    }
    // Standalone markers carry no length: SOI, TEM and the eight restart markers.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // EOI, or the start of entropy-coded scan data — past here there is no header.
    if (marker === 0xd9 || marker === 0xda) return null;

    const length = b.readUInt16BE(i + 2);
    if (length < 2) return null;

    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      if (i + 9 > b.length) return null;
      // [marker][length:2][precision:1][height:2][width:2] — height first.
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { contentType: 'image/jpeg', width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

/** IHDR is mandatory and always the first chunk, so the offsets are fixed. */
function png(b: Buffer): ProbedImage | null {
  if (b.length < 24 || b.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  return width > 0 && height > 0 ? { contentType: 'image/png', width, height } : null;
}

/** Three container variants, one per encoder: lossy, lossless, extended. */
function webp(b: Buffer): ProbedImage | null {
  const chunk = b.subarray(12, 16).toString('latin1');

  if (chunk === 'VP8 ' && b.length >= 30) {
    // The 3-byte start code guards against reading a frame that is not there.
    if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return null;
    const width = b.readUInt16LE(26) & 0x3fff;
    const height = b.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { contentType: 'image/webp', width, height } : null;
  }

  if (chunk === 'VP8L' && b.length >= 25) {
    if (b[20] !== 0x2f) return null;
    // 14 bits of width then 14 of height, little-endian, both stored minus one.
    const bits = b.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { contentType: 'image/webp', width, height };
  }

  if (chunk === 'VP8X' && b.length >= 30) {
    const width = b.readUIntLE(24, 3) + 1;
    const height = b.readUIntLE(27, 3) + 1;
    return { contentType: 'image/webp', width, height };
  }

  return null;
}
