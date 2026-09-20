/**
 * @file shared/recordingFilename.ts
 *
 * The one place that knows what a recording file is called.
 *
 * `{slug}-{YYYYMMDDTHHmmss}-{stream}.{ext}` — the slug is whatever the tab was
 * called and may be absent, the stamp is UTC, and the stream suffix is
 * `recording`, `mic` or `self-video`.
 *
 * It lives alone because it did not used to. The grammar was known
 * independently by seven places — a builder in the recorder, a regex in the
 * Drive folder namer, a second regex for the popup's title, a third for the
 * history label, and the stream suffix sniffed by two copies of the same
 * expression — and they drifted. Twice in one week the builder changed and the
 * readers did not: the slug stopped being `google-meet-…` and the stamp gained
 * seconds. Nothing threw. Orphan recovery matched no files and quietly
 * recovered nothing for three months, and every Drive folder was named after
 * the moment of upload instead of the meeting.
 *
 * So the rule is: build here, parse here, and derive everything else from
 * {@link parseRecordingFilename}. A second regex over a filename anywhere else
 * in the codebase is the bug coming back.
 */

import type { RecordingFileExtension } from './recordingFormats';
import type { RecordingStream } from './recordingTypes';

/** What each stream's file is called. `tab` is the recording proper. */
const STREAM_SUFFIX: Record<RecordingStream, string> = {
  tab: 'recording',
  mic: 'mic',
  'self-video': 'self-video',
};

const SUFFIX_STREAM: Record<string, RecordingStream> = {
  recording: 'tab',
  mic: 'mic',
  'self-video': 'self-video',
};

/**
 * The grammar. The slug group is optional because a page with no usable title
 * produces none, and the time takes four digits or six because files written
 * before the stamp gained seconds still exist.
 */
const RECORDING_FILENAME_RE =
  /^(?:(.+)-)?(\d{8}T\d{4,6})-(recording|mic|self-video)\.(webm|mp4|m4a)$/;

export type ParsedRecordingFilename = {
  /** Whatever the tab was called; empty when the page had no usable title. */
  slug: string;
  /** `YYYYMMDDTHHmmss`, or `YYYYMMDDTHHmm` on a file named before seconds. */
  stamp: string;
  stream: RecordingStream;
  extension: RecordingFileExtension;
};

/** Builds the name a freshly captured stream is written under. */
export function buildRecordingFilename(
  slug: string,
  stream: RecordingStream,
  extension: RecordingFileExtension = 'webm',
  now: Date = new Date(),
): string {
  const prefix = slug ? `${slug}-` : '';
  return `${prefix}${utcStamp(now)}-${STREAM_SUFFIX[stream]}.${extension}`;
}

/** Reads a name this extension produced, or null for anything else. */
export function parseRecordingFilename(filename: string): ParsedRecordingFilename | null {
  const m = filename.match(RECORDING_FILENAME_RE);
  if (!m) return null;
  return {
    slug: m[1] ?? '',
    stamp: m[2],
    stream: SUFFIX_STREAM[m[3]],
    extension: m[4] as RecordingFileExtension,
  };
}

/** True when a name looks like a recording artifact this extension produced. */
export function isRecordingFilename(filename: string): boolean {
  return RECORDING_FILENAME_RE.test(filename);
}

/** Which stream's file this is; `tab` for anything unrecognised, as before. */
export function recordingStreamOf(filename: string): RecordingStream {
  return parseRecordingFilename(filename)?.stream ?? 'tab';
}

/**
 * The name without its stream suffix — what the several files of one recording
 * have in common, and so what their shared Drive folder is called.
 */
export function recordingGroupName(filename: string): string | null {
  const parsed = parseRecordingFilename(filename);
  if (!parsed) return null;
  return parsed.slug ? `${parsed.slug}-${parsed.stamp}` : parsed.stamp;
}

/**
 * The name without its stream suffix, for a file that may no longer carry a
 * stamp: renaming a saved recording rewrites it as `{slug}-recording.webm`, and
 * a sidecar still has to be named to sit beside it. Prefer
 * {@link recordingGroupName} where the stamp matters.
 */
export function stripStreamSuffix(filename: string): string {
  const suffixes = Object.values(STREAM_SUFFIX).join('|');
  return filename.replace(new RegExp(`-(?:${suffixes})\\.[a-z0-9]+$`, 'i'), '') || filename;
}

/** The same name under a new slug, keeping the stamp the folder is keyed on. */
export function retitleRecordingFilename(filename: string, slug: string): string | null {
  const parsed = parseRecordingFilename(filename);
  if (!parsed || !slug) return null;
  return `${slug}-${parsed.stamp}-${STREAM_SUFFIX[parsed.stream]}.${parsed.extension}`;
}

/**
 * When the recording started, from its own name.
 *
 * The stamp is UTC, so it is parsed as UTC — read as local time it would be
 * hours out, and anything derived from it worse than useless.
 */
export function recordingStartedAtMs(filename: string): number | null {
  const parsed = parseRecordingFilename(filename);
  if (!parsed) return null;
  const [date, time] = parsed.stamp.split('T');
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    + `T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.length >= 6 ? time.slice(4, 6) : '00'}Z`;
  const parsedMs = Date.parse(iso);
  return Number.isFinite(parsedMs) ? parsedMs : null;
}

/**
 * Filesystem-safe UTC stamp: `YYYYMMDDTHHmmss`. Seconds are included so two
 * recordings of one meeting started in the same minute cannot collide.
 */
function utcStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:]/g, '');
}
