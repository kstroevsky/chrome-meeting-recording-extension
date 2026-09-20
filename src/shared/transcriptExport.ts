/**
 * @file shared/transcriptExport.ts
 *
 * Renders a recording's transcript to WebVTT, so it is delivered as a file
 * beside the media rather than living only inside the extension (design `d4`,
 * `n2a`). The same format the notes sidecar uses (ADR-0005): a `.vtt` is
 * `start --> end` plus text, which every player and `<track>` already reads.
 *
 * Speakers become WebVTT voice spans, `<v Maria>`, because that is how the
 * format names who is talking — and a reader that does not understand voices
 * still shows the words.
 *
 * Pure and side-effect free: the offscreen uploads whatever this returns.
 */

import type { Transcript, TranscriptSegment } from './transcript';

/** A cue must end after it starts; a zero-length segment is given a short one. */
const MIN_CUE_MS = 200;

/** True when the transcript would produce a file worth delivering. */
export function hasExportableTranscript(transcript: Transcript | undefined): boolean {
  return exportable(transcript?.segments ?? []).length > 0;
}

export function transcriptToWebVtt(transcript: Transcript): string {
  const lines: string[] = ['WEBVTT', ''];
  exportable(transcript.segments).forEach((segment, index) => {
    const start = Math.max(0, Math.round(segment.tStartMs));
    const end = Math.max(Math.round(segment.tEndMs), start + MIN_CUE_MS);
    lines.push(String(index + 1));
    lines.push(`${timestamp(start)} --> ${timestamp(end)}`);
    lines.push(cueText(segment));
    lines.push('');
  });
  return lines.join('\n');
}

/** In time order, without the blank lines a caption stream can leave behind. */
function exportable(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return segments
    .filter((segment) => segment.text.trim().length > 0 && Number.isFinite(segment.tStartMs) && Number.isFinite(segment.tEndMs))
    .sort((left, right) => left.tStartMs - right.tStartMs);
}

function cueText(segment: TranscriptSegment): string {
  const text = escapeCue(segment.text.trim());
  const speaker = segment.speaker?.trim();
  // A voice span holds a name with spaces, but not one with a closing bracket.
  return speaker ? `<v ${speaker.replace(/>/g, '')}>${text}` : text;
}

/**
 * WebVTT reads `<`, `&` and a line starting `-->` as markup, so they are escaped
 * rather than trusted: a transcript is other people's words.
 */
function escapeCue(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .replace(/-->/g, '--&gt;');
}

/** `HH:MM:SS.mmm` — WebVTT's long form, which every parser accepts. */
function timestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}
