import type { RecordingStream } from './recordingTypes';

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
export function buildRenamedRecordingFilename(
  title: string,
  stream: RecordingStream,
  currentFilename: string,
  kind?: 'notes',
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
