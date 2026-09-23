import type { RecordingArtifactKind, RecordingStream } from './recordingTypes';

/** What a notes sidecar is called, whatever media stream it was delivered beside. */
const NOTES_FILENAME_SUFFIX = 'notes';

const STREAM_FILENAME_SUFFIX: Record<RecordingStream, string> = {
  tab: 'recording',
  mic: 'mic',
  'self-video': 'self-video',
};

/** Turns a user-visible recording title into a lowercase, Unicode-safe Drive name. */
export function slugifyRecordingTitle(title: string): string {
  return title
    .trim()
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Builds one renamed artifact filename while preserving its resolved extension.
 *
 * The notes sidecar is named for what it *is*, not for the stream it rode along
 * with: it carries a media stream only so the upload can order it, and naming it
 * after that stream made it collide with the real file of the same stream.
 */
/**
 * The name a recording would take when one of that name already exists (design
 * 7C): `Team sync — Jul 11` becomes `Team sync — Jul 11 (2)`. Returns null when
 * the name is free.
 *
 * Saving keeps both rather than refusing or overwriting. Two meetings really do
 * share a name — a weekly sync is called the same thing every week — so a
 * collision is normal, and the only wrong answers are losing one of them or
 * making the user invent a name they did not want.
 *
 * Compared case-insensitively and on trimmed text, because `team sync` and
 * `Team sync ` are the same name to everyone except a string comparison.
 */
export function suffixedRecordingName(name: string, taken: readonly string[]): string | null {
  const wanted = name.trim();
  if (!wanted) return null;
  const used = new Set(taken.map((existing) => existing.trim().toLocaleLowerCase()));
  if (!used.has(wanted.toLocaleLowerCase())) return null;
  // Starts at 2 because the one already there is, in effect, the first.
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${wanted} (${n})`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  return null;
}

export function buildRenamedRecordingFilename(
  title: string,
  stream: RecordingStream,
  currentFilename: string,
  kind?: RecordingArtifactKind,
): string {
  const slug = slugifyRecordingTitle(title);
  if (!slug) throw new Error('Recording name must contain at least one letter or number');
  const dot = currentFilename.lastIndexOf('.');
  const extension = dot >= 0 && dot < currentFilename.length - 1
    ? currentFilename.slice(dot + 1)
    : '';
  if (!extension) throw new Error(`Recording file has no extension: ${currentFilename}`);
  const suffix = kind === 'notes' ? NOTES_FILENAME_SUFFIX : STREAM_FILENAME_SUFFIX[stream];
  return `${slug}-${suffix}.${extension}`;
}
