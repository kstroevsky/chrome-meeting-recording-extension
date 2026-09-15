/**
 * @file recordings/player/playerTopics.ts
 *
 * What the TOPICS dropdown is a list *of* — the sibling of `playerTracks.ts`,
 * and the same kind of thing: a pure projection of the manifest into rows,
 * kept out of the view so the wording and ordering can be tested without a DOM.
 *
 * The list is UI-02's, exactly:
 *
 * ```text
 * ● redis · timeout · workers · pool     23 min
 * ● berlin · hotel · flight              12 min
 * ● interview · frontend · candidate     17 min
 * ```
 *
 * Deliberately **not** ordered by when each topic first came up. The manifest
 * sorts by importance, and that order is kept: a list the reader scans top-down
 * should answer "what was this call about" before "what happened first", which
 * the scrubber already shows.
 */

import type { PlaybackTopic } from '../../shared/playback';
import { formatTopicDuration, topicLabel, TOPIC_SHADES } from './playerFormat';

export type TopicDescriptor = {
  id: string;
  /** `redis · timeout · workers · pool`. */
  label: string;
  /** `23 min`. */
  duration: string;
  /** Matches the scrubber band's shade for the same topic. */
  shade: number;
  /** Where picking this row seeks to. */
  seekMs: number;
  /** How many separate stretches it covers; 2+ is worth saying (MODEL-04). */
  spanCount: number;
};

export function describeTopics(topics: readonly PlaybackTopic[]): TopicDescriptor[] {
  return topics.map((topic, index) => ({
    id: topic.id,
    label: topicLabel(topic),
    duration: formatTopicDuration(topic.totalMs),
    // Keyed to the manifest's order, which is the order the bands were shaded
    // in — so a row and its bands always agree.
    shade: index % TOPIC_SHADES,
    seekMs: topic.spans[0]?.tStartMs ?? 0,
    spanCount: topic.spans.length,
  }));
}

/**
 * The hint shown beside a topic the conversation came back to.
 *
 * Empty for a topic discussed once, because every topic would otherwise carry a
 * "1 stretch" badge that says nothing. Recurrence is the interesting case and
 * the only one the payload's worked example cares about.
 */
export function recurrenceHint(topic: Pick<TopicDescriptor, 'spanCount'>): string {
  return topic.spanCount > 1 ? `${topic.spanCount}×` : '';
}

/** What the TOPICS trigger counts. */
export function topicCount(topics: readonly TopicDescriptor[]): number {
  return topics.length;
}
