/**
 * @file shared/notationExport.ts
 *
 * Renders notations to WebVTT — the sidecar format ADR-0005 chose over writing
 * them into the media container. A `.vtt` file is `start --> end` plus text,
 * which *is* the notation model, and it is the standard chapters/cues format,
 * so players and `<track kind="chapters">` read it without help from us.
 *
 * Pure and side-effect free: the offscreen uploads whatever this returns.
 */

import { normalizeRecordingNotations, type RecordingNotation } from './notations';

/**
 * WebVTT requires a cue to end after it starts. A point mark has no width, so
 * it is given a short one — long enough for a player to land on.
 */
const MIN_CUE_MS = 1_000;

export type WebVttOptions = {
  /**
   * The recording's length. An open span (one the run never sealed) ends here
   * rather than being dropped — losing a note at export would undo the whole
   * point of sealing it in the first place.
   */
  durationMs?: number;
};

/** True when the notations would produce a file worth uploading. */
export function hasExportableNotations(notations: RecordingNotation[]): boolean {
  return normalizeRecordingNotations(notations).length > 0;
}

export function toWebVtt(notations: RecordingNotation[], options: WebVttOptions = {}): string {
  const ordered = normalizeRecordingNotations(notations);
  const lines: string[] = ['WEBVTT', ''];

  ordered.forEach((notation, index) => {
    const start = notation.tStartMs;
    const ceiling = options.durationMs != null && options.durationMs > start ? options.durationMs : undefined;
    const rawEnd = notation.tEndMs ?? ceiling ?? start;
    const end = Math.max(rawEnd, start + MIN_CUE_MS);
    lines.push(String(index + 1));
    lines.push(`${timestamp(start)} --> ${timestamp(end)}`);
    lines.push(cueText(notation.text));
    lines.push('');
  });

  return lines.join('\n');
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

/**
 * A cue payload cannot contain a blank line (it would end the cue) or the arrow
 * (it would read as a timing line), and an empty note still has to occupy its
 * moment — so it is named rather than written as an empty cue.
 */
function cueText(text: string): string {
  const collapsed = text.replace(/\r?\n/g, ' ').replace(/-->/g, '→').trim();
  return collapsed || 'Unnamed note';
}
