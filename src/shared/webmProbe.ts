/**
 * @file shared/webmProbe.ts
 *
 * Reads just enough of a WebM (Matroska) file to say what it is and how long it
 * runs, from a few kilobytes at each end — so a recording's duration can be
 * learned from Drive without downloading the recording.
 *
 * - {@link probeWebmHead}: the first bytes → is it WebM at all (a notes file saved
 *   under a video's name is not), its codecs, and the duration in its header.
 * - {@link probeWebmTail}: the last bytes → the last media timestamp. A live
 *   MediaRecorder file never repaired has no header duration; this is its
 *   length. When a header duration exists and the content ends well before it,
 *   the file was cut short.
 *
 * Deliberately small: only the elements named below are read, and anything it
 * does not recognise ends the walk rather than being guessed at.
 */

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  CODEC_ID: 0x86,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  CLUSTER: 0x1f43b675,
  CUES: 0x1c53bb6b,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
} as const;

/** An element whose size is "unknown": a live stream still being written. */
const UNKNOWN = -1;
const DEFAULT_TIMECODE_SCALE = 1_000_000;

export type WebmHead = {
  kind: 'webm' | 'mp4' | 'text' | 'unknown';
  codecs: string[];
  /** From the header's Duration element; null when the header has none. */
  durationMs: number | null;
  timecodeScale: number;
};

function readId(b: Uint8Array, p: number): { id: number; len: number } | null {
  const first = b[p];
  if (first === undefined || first === 0) return null;
  let len = 1;
  for (let mask = 0x80; len <= 4 && !(first & mask); mask >>= 1) len++;
  if (len > 4 || p + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[p + i];
  return { id, len };
}

function readSize(b: Uint8Array, p: number): { size: number; len: number } | null {
  const first = b[p];
  if (first === undefined || first === 0) return null;
  let len = 1;
  let mask = 0x80;
  for (; len <= 8 && !(first & mask); mask >>= 1) len++;
  if (len > 8 || p + len > b.length) return null;
  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[p + i];
    if (b[p + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? UNKNOWN : value, len };
}

function readUint(b: Uint8Array, p: number, n: number): number {
  let value = 0;
  for (let i = 0; i < n; i++) value = value * 256 + b[p + i];
  return value;
}

function readFloat(b: Uint8Array, p: number, n: number): number {
  if (p + n > b.length) return Number.NaN;
  const view = new DataView(b.buffer, b.byteOffset + p, n);
  return n === 4 ? view.getFloat32(0) : n === 8 ? view.getFloat64(0) : Number.NaN;
}

/** Children of [start, end): calls `visit` until it returns false. */
function walk(
  b: Uint8Array,
  start: number,
  end: number,
  visit: (id: number, data: number, size: number) => boolean | void,
): void {
  let p = start;
  while (p < end) {
    const id = readId(b, p);
    if (!id) return;
    const size = readSize(b, p + id.len);
    if (!size) return;
    const data = p + id.len + size.len;
    if (visit(id.id, data, size.size) === false || size.size === UNKNOWN) return;
    p = data + size.size;
  }
}

const ascii = (b: Uint8Array, p: number, n: number) => String.fromCharCode(...b.subarray(p, Math.min(p + n, b.length)));

export function probeWebmHead(b: Uint8Array): WebmHead {
  const head: WebmHead = { kind: 'unknown', codecs: [], durationMs: null, timecodeScale: DEFAULT_TIMECODE_SCALE };
  if (b.length >= 8 && ascii(b, 4, 4) === 'ftyp') return { ...head, kind: 'mp4' };
  if (ascii(b, 0, 6) === 'WEBVTT' || b[0] === 0x3c || b[0] === 0x7b) return { ...head, kind: 'text' };

  const ebml = readId(b, 0);
  const ebmlSize = ebml?.id === ID.EBML ? readSize(b, ebml.len) : null;
  if (!ebml || !ebmlSize || ebmlSize.size === UNKNOWN) return head;
  const segmentAt = ebml.len + ebmlSize.len + ebmlSize.size;
  const segment = readId(b, segmentAt);
  const segmentSize = segment?.id === ID.SEGMENT ? readSize(b, segmentAt + segment.len) : null;
  if (!segment || !segmentSize) return head;
  head.kind = 'webm';

  let rawDuration: number | null = null;
  walk(b, segmentAt + segment.len + segmentSize.len, b.length, (id, data, size) => {
    if (id === ID.CLUSTER || size === UNKNOWN) return false;
    const end = Math.min(data + size, b.length);
    if (id === ID.INFO) {
      walk(b, data, end, (child, childData, childSize) => {
        if (child === ID.TIMECODE_SCALE) head.timecodeScale = readUint(b, childData, childSize);
        if (child === ID.DURATION) rawDuration = readFloat(b, childData, childSize);
      });
    }
    if (id === ID.TRACKS) {
      walk(b, data, end, (track, trackData, trackSize) => {
        if (track !== ID.TRACK_ENTRY) return;
        walk(b, trackData, Math.min(trackData + trackSize, b.length), (field, fieldData, fieldSize) => {
          if (field === ID.CODEC_ID) head.codecs.push(ascii(b, fieldData, fieldSize));
        });
      });
    }
  });
  if (rawDuration != null && Number.isFinite(rawDuration) && rawDuration > 0) {
    head.durationMs = Math.round((rawDuration * head.timecodeScale) / 1_000_000);
  }
  return head;
}

/** The last media timestamp in these (final) bytes, in ms; null when none is found. */
export function probeWebmTail(b: Uint8Array, timecodeScale = DEFAULT_TIMECODE_SCALE): number | null {
  for (let p = b.length - 4; p >= 0; p--) {
    if (b[p] !== 0x1f || b[p + 1] !== 0x43 || b[p + 2] !== 0xb6 || b[p + 3] !== 0x75) continue;
    const size = readSize(b, p + 4);
    if (!size) continue;
    const data = p + 4 + size.len;
    const end = size.size === UNKNOWN ? b.length : Math.min(data + size.size, b.length);
    let clusterTime: number | null = null;
    let lastOffset = 0;
    walk(b, data, end, (id, childData, childSize) => {
      if (id === ID.CLUSTER || id === ID.CUES) return false;
      if (id === ID.TIMECODE && childSize > 0 && childSize <= 8) clusterTime = readUint(b, childData, childSize);
      if (id === ID.SIMPLE_BLOCK && clusterTime != null && childData + 3 < b.length) {
        const track = readSize(b, childData);
        if (track) lastOffset = Math.max(lastOffset, new DataView(b.buffer, b.byteOffset + childData + track.len, 2).getInt16(0));
      }
      return childSize !== UNKNOWN;
    });
    if (clusterTime != null) return Math.round(((clusterTime + lastOffset) * timecodeScale) / 1_000_000);
  }
  return null;
}

/**
 * The recording's length from both ends: the header's, unless the content
 * ends well before it (a cut-short file is as long as its content).
 */
export function webmDurationMs(head: WebmHead, tailMs: number | null): { durationMs: number | null; cutShort: boolean } {
  const cutShort = head.durationMs != null && tailMs != null && tailMs < head.durationMs * 0.9 - 5000;
  return { durationMs: cutShort ? tailMs : (head.durationMs ?? tailMs), cutShort };
}
