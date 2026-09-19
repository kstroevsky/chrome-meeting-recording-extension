/**
 * @file recordings/noteEditorModel.ts
 *
 * What the note editor (design `f5`, `f6`) shows, kept apart from its DOM so the
 * rules can be tested on their own: which note each transcript line sits in,
 * which lines a span being made covers, and how a span is written down.
 *
 * Lines, notes and the playhead share one clock — media-relative milliseconds —
 * so every rule here is a range test (ADR-0005, ADR-0007).
 */

import type { RecordingNotation } from '../shared/notations';
import type { TranscriptSegment } from '../shared/transcript';
import { railItems } from './player/playerTranscript';
import { formatClock } from './player/playerFormat';

/** One transcript line in the editor, with the saved note it already belongs to. */
export type EditorLine = {
  segment: TranscriptSegment;
  /** Index into the time-sorted segments. */
  index: number;
  noteId: string | null;
  /** The note's name, on the first line of its run only; `''` for an unnamed note. */
  noteName: string | null;
  /** Where the line sits in its note's run, for the gold rail's rounded ends. */
  edge: 'first' | 'middle' | 'last' | 'single' | null;
};

/**
 * The transcript as the editor lists it (f5): each line knows the saved note it
 * was said during, and the first line of a note's run carries its name, which
 * the editor prints in the gutter beside it.
 */
export function editorLines(segments: TranscriptSegment[], notations: RecordingNotation[]): EditorLine[] {
  const lines: EditorLine[] = [];
  let pendingName: string | null = null;
  for (const item of railItems(segments, notations)) {
    if (item.kind === 'heading') { pendingName = item.notation.text; continue; }
    lines.push({ segment: item.segment, index: item.index, noteId: item.noteId, noteName: pendingName, edge: item.edge });
    pendingName = null;
  }
  return lines;
}

/** A span being made: its start, and its end once it has one (an open span runs to the playhead). */
export type DraftSpan = { tStartMs: number; tEndMs: number | null };

/** The span covered by dragging from one line to another, whichever way the drag went. */
export function spanOfLines(lines: EditorLine[], from: number, to: number): DraftSpan {
  const first = lines[Math.min(from, to)];
  const last = lines[Math.max(from, to)];
  return { tStartMs: first.segment.tStartMs, tEndMs: Math.max(last.segment.tEndMs, first.segment.tStartMs) };
}

/**
 * The lines a span covers, as a run: any line whose start falls inside it. An
 * open span reaches the playhead, so it covers what has been said so far.
 */
export function linesInSpan(lines: EditorLine[], span: DraftSpan, playheadMs: number): Set<number> {
  const end = span.tEndMs ?? Math.max(playheadMs, span.tStartMs);
  const covered = new Set<number>();
  for (const line of lines) {
    const start = line.segment.tStartMs;
    if (start >= span.tStartMs && (start < end || (start === span.tStartMs))) covered.add(line.index);
  }
  return covered;
}

/** `05:38 → 06:19`, or `05:38 → running` for a span that has not ended. */
export function formatSpan(span: DraftSpan): string {
  return `${formatClock(span.tStartMs)} → ${span.tEndMs == null ? 'running' : formatClock(span.tEndMs)}`;
}

/** A length reads on its own, so it is not padded: `0:41`, `1:04`, `1:02:07`. */
export function formatLength(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** The footer's count: `7 NOTES`, and `· 1 OPEN` while a span is being made. */
export function noteCount(saved: number, open: boolean): string {
  return `${saved} ${saved === 1 ? 'NOTE' : 'NOTES'}${open ? ' · 1 OPEN' : ''}`;
}
