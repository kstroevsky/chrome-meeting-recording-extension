/**
 * @file recordings/player/playerFormat.ts
 *
 * Pure helpers behind the player chrome. Kept apart from the DOM so the
 * scrubber's arithmetic — the part that is actually easy to get wrong — can be
 * tested without a media element.
 */

import type { RecordingNotation } from '../../shared/notations';

/** `mm:ss`, or `h:mm:ss` past an hour. Tabular numerals are applied in CSS. */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

export type NoteMark = {
  id: string;
  /** Percentage offsets, ready for `left`/`width` on the scrubber. */
  leftPct: number;
  widthPct: number;
  /** An unnamed note renders in the pale variant (ADR-0006 design §f12). */
  named: boolean;
  label: string;
  startMs: number;
};

/** Below this a span is invisible, so it renders as a tick instead. */
const MIN_MARK_PCT = 0.6;

/**
 * Places notes on the scrubber. A point note (no end) and a span too short to
 * see both become a minimum-width tick, because a mark you cannot hit is worse
 * than one that slightly overstates its length.
 */
export function toNoteMarks(notations: readonly RecordingNotation[], durationMs: number): NoteMark[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  return notations
    .filter((note) => Number.isFinite(note.tStartMs) && note.tStartMs >= 0)
    .map((note) => {
      const start = Math.min(note.tStartMs, durationMs);
      const end = Math.min(Math.max(note.tEndMs ?? start, start), durationMs);
      const leftPct = (start / durationMs) * 100;
      return {
        id: note.id,
        leftPct,
        widthPct: Math.min(Math.max(((end - start) / durationMs) * 100, MIN_MARK_PCT), 100 - leftPct),
        named: note.text.trim().length > 0,
        label: note.text.trim() || 'Name this one',
        startMs: start,
      };
    })
    .sort((a, b) => a.leftPct - b.leftPct);
}

/** Fraction of the track a pointer landed on, clamped to [0, 1]. */
export function seekFraction(clientX: number, rect: { left: number; width: number }): number {
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}
