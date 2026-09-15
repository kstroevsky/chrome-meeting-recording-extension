/**
 * @file recordings/player/playerFormat.ts
 *
 * Pure helpers behind the player chrome. Kept apart from the DOM so the
 * scrubber's arithmetic — the part that is actually easy to get wrong — can be
 * tested without a media element.
 */

import type { RecordingNotation } from '../../shared/notations';
import type { PlaybackTopic } from '../../shared/playback';

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

/**
 * How many shades the topic band cycles through.
 *
 * Four, not one per topic. The palette is a deliberate warm cream and red, and
 * a per-topic hue ramp would import a second visual language into it. What the
 * band has to convey is *recurrence* — that the subject at 05:00 is the subject
 * again at 31:00 — so a shade is keyed to the topic and stays with it across
 * every span. Past four topics two will share a shade; the label and the
 * TOPICS list disambiguate, and the band was never the identifier.
 */
export const TOPIC_SHADES = 4;

export type TopicBand = {
  topicId: string;
  /** Percentage offsets, ready for `left`/`width` on the scrubber. */
  leftPct: number;
  widthPct: number;
  /** 0…{@link TOPIC_SHADES}-1, stable for a topic across all of its spans. */
  shade: number;
  label: string;
  startMs: number;
};

/**
 * Places every topic's spans on the scrubber, in time order.
 *
 * Returned flat rather than grouped by topic because that is how they are
 * drawn, and because painting them in time order means an earlier band can
 * never overlap a later one it was supposed to sit beside.
 */
export function toTopicBands(topics: readonly PlaybackTopic[], durationMs: number): TopicBand[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];
  const bands: TopicBand[] = [];
  topics.forEach((topic, index) => {
    const label = topicLabel(topic);
    for (const span of topic.spans) {
      const start = Math.min(Math.max(span.tStartMs, 0), durationMs);
      const end = Math.min(Math.max(span.tEndMs, start), durationMs);
      const leftPct = (start / durationMs) * 100;
      bands.push({
        topicId: topic.id,
        leftPct,
        // Same floor as a note mark: a band too thin to hit is worse than one
        // that slightly overstates a short topic.
        widthPct: Math.min(Math.max(((end - start) / durationMs) * 100, MIN_MARK_PCT), 100 - leftPct),
        shade: index % TOPIC_SHADES,
        label,
        startMs: start,
      });
    }
  });
  return bands.sort((a, b) => a.leftPct - b.leftPct);
}

/** UI-02's label: keywords joined by a middot, strongest first. */
export function topicLabel(topic: Pick<PlaybackTopic, 'keywords'>): string {
  return topic.keywords.join(' · ') || 'Untitled topic';
}

/**
 * UI-02's `23 min`.
 *
 * Rounded to whole minutes, because the number is there to say how much of the
 * call a subject took, and a topic reported as `23 min 14 s` invites a
 * precision the segmentation does not have — boundaries are quantized to
 * four-utterance windows (ADR-0007).
 */
export function formatTopicDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 min';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '< 1 min';
  if (minutes < 60) return `${minutes} min`;
  const remainder = minutes % 60;
  return remainder ? `${Math.floor(minutes / 60)} h ${remainder} min` : `${Math.floor(minutes / 60)} h`;
}
