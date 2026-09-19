/**
 * @file recordings/player/playerTranscript.ts
 *
 * What the transcript rail is a list of (design `f10`), kept apart from the DOM
 * so the grouping — the part that decides which note a line belongs to — can be
 * tested without a player.
 *
 * Segments and notes share one clock: both are media-relative, pause-aware
 * milliseconds (ADR-0005, ADR-0007), so "this line was said during that note"
 * is a plain range test rather than a conversion.
 */

import type { RecordingNotation } from '../../shared/notations';
import type { TranscriptSegment } from '../../shared/transcript';

/** One entry in the rail: a note's sticky heading, or a transcript line. */
export type RailItem =
  | { kind: 'heading'; notation: RecordingNotation }
  | {
    kind: 'line';
    segment: TranscriptSegment;
    /** Index into the time-sorted segments, the same one the playing line is found by. */
    index: number;
    /** The note this line was said during, if any. */
    noteId: string | null;
    /** Where the line sits in its note's run, for the gold rail's rounded ends. */
    edge: 'first' | 'middle' | 'last' | 'single' | null;
  };

export function sortSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  return [...segments].sort((left, right) => left.tStartMs - right.tStartMs);
}

/**
 * A note's reach: from its start to its end, or — for a note that was never
 * closed — to the next note's start.
 */
function noteRanges(notations: RecordingNotation[]): Array<{ notation: RecordingNotation; from: number; to: number }> {
  const sorted = [...notations].sort((left, right) => left.tStartMs - right.tStartMs);
  return sorted.map((notation, index) => ({
    notation,
    from: notation.tStartMs,
    to: notation.tEndMs ?? sorted[index + 1]?.tStartMs ?? Number.POSITIVE_INFINITY,
  }));
}

/**
 * The rail, in order: each run of lines that fall in one note is preceded by
 * that note's heading. A line belongs to the earliest-starting note whose range
 * holds its start, so where notes overlap the one already running keeps it.
 */
export function railItems(segments: TranscriptSegment[], notations: RecordingNotation[]): RailItem[] {
  const ranges = noteRanges(notations);
  const lines = sortSegments(segments).map((segment, index) => ({
    segment,
    index,
    note: ranges.find((range) => range.from <= segment.tStartMs && segment.tStartMs < range.to)?.notation ?? null,
  }));
  const items: RailItem[] = [];
  lines.forEach((line, position) => {
    const previous = lines[position - 1]?.note?.id ?? null;
    const next = lines[position + 1]?.note?.id ?? null;
    const noteId = line.note?.id ?? null;
    if (line.note && previous !== noteId) items.push({ kind: 'heading', notation: line.note });
    const opens = previous !== noteId;
    const closes = next !== noteId;
    const edge = !noteId ? null : opens && closes ? 'single' : opens ? 'first' : closes ? 'last' : 'middle';
    items.push({ kind: 'line', segment: line.segment, index: line.index, noteId, edge });
  });
  return items;
}

/**
 * The line being spoken at `positionMs`, or -1 between lines. Binary search:
 * an hour-long call is a few thousand lines, and this runs on every tick.
 */
export function activeSegmentIndex(sorted: TranscriptSegment[], positionMs: number): number {
  let low = 0;
  let high = sorted.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (sorted[middle].tStartMs <= positionMs) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate >= 0 && positionMs < sorted[candidate].tEndMs ? candidate : -1;
}

function srtTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/** The transcript as SubRip, the rail's SRT download: numbered cues, speaker first. */
export function toSrt(segments: TranscriptSegment[]): string {
  return sortSegments(segments).map((segment, index) => [
    String(index + 1),
    `${srtTimestamp(segment.tStartMs)} --> ${srtTimestamp(segment.tEndMs)}`,
    segment.speaker ? `${segment.speaker}: ${segment.text}` : segment.text,
  ].join('\n')).join('\n\n') + (segments.length ? '\n' : '');
}
