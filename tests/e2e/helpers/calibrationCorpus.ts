/**
 * Synthetic meetings with known structure, for 4B calibration.
 *
 * **What this can and cannot settle.** Generated topics are lexically cleaner
 * than real ones, so thresholds tuned here will run *confident*: a merge
 * threshold that separates "Redis" from "Berlin" in synthetic text may split a
 * real conversation that drifts between related subjects. Treat the output as a
 * starting region rather than a final value, and expect real-transcript
 * calibration to loosen rather than tighten it.
 *
 * The generator fights that where it can: topics share vocabulary, transitions
 * are sometimes gradual rather than abrupt, asides interrupt a topic without
 * ending it, and only some boundaries get a discourse cue or a long pause.
 */

import type { TranscriptSegment } from '../../../src/shared/transcript';

export type CalibrationCase = {
  name: string;
  segments: TranscriptSegment[];
  /** True topic id per utterance, index-aligned with `segments`. */
  topicOfUtterance: string[];
};

type Topic = { id: string; lines: string[] };

/** Deliberately overlapping vocabulary: "pool", "limit", "release", "book" recur across subjects. */
const TOPICS: Topic[] = [
  {
    id: 'redis',
    lines: [
      'the redis connection pool is saturated again under load',
      'timeouts climbed once the pool hit its connection limit',
      'we could raise the limit or shard the cache before the release',
      'the workers queue behind the pool and nothing drains',
      'connection reuse would help more than raising the ceiling',
    ],
  },
  {
    id: 'travel',
    lines: [
      'the berlin flight leaves early on thursday morning',
      'we should book the hotel for the night before',
      'travel budget covers three nights of accommodation',
      'the offsite booking needs to go in before the release of funds',
      'flights are cheaper if we book the whole group together',
    ],
  },
  {
    id: 'hiring',
    lines: [
      'the frontend candidate interviewed well with the panel',
      'the panel wants a second conversation before an offer',
      'headcount limit is two engineers and one designer this quarter',
      'we should book the follow up interview for next week',
      'the candidate asked about the release cadence and the on call rota',
    ],
  },
  {
    id: 'release',
    lines: [
      'deploy is blocked on the migration finishing first',
      'rollback took eleven minutes which is longer than the incident',
      'the release notes still reference the old cache behaviour',
      'we should cut the release once the pool changes land',
      'staging has been green for two days now',
    ],
  },
];

const BACKCHANNEL = ['yeah', 'right', 'okay', 'mm hmm', 'sure', 'exactly', 'i see', 'agreed'];
const ASIDE = [
  'sorry can you repeat that',
  'my connection dropped for a second',
  'is anyone else seeing the echo',
  'let me share my screen',
];
const CUES = ['anyway', 'by the way', 'moving on', 'another thing', 'next question', 'speaking of'];
const SPEAKERS = ['Ada', 'Grace', 'Linus', 'Barbara'];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds one meeting from a schedule of `[topicId, utteranceCount]` blocks.
 *
 * A topic appearing twice in the schedule is a *recurrence*: the same subject,
 * separated by others — the case MODEL-04 exists for and the one a
 * single-pass clusterer can only solve by merging.
 */
export function buildMeeting(
  name: string,
  schedule: [string, number][],
  seed: number,
): CalibrationCase {
  const random = rng(seed);
  const segments: TranscriptSegment[] = [];
  const topicOfUtterance: string[] = [];
  let clock = 0;

  schedule.forEach(([topicId, count], block) => {
    const topic = TOPICS.find((t) => t.id === topicId)!;
    for (let i = 0; i < count; i += 1) {
      let text: string;
      if (i === 0 && block > 0 && random() < 0.5) {
        // Only some boundaries announce themselves (SEG-06).
        text = `${CUES[Math.floor(random() * CUES.length)]}, ${topic.lines[Math.floor(random() * topic.lines.length)]}`;
      } else if (random() < 0.22) {
        text = BACKCHANNEL[Math.floor(random() * BACKCHANNEL.length)];
      } else if (random() < 0.08) {
        // An aside interrupts without ending the topic — it must not read as a boundary.
        text = ASIDE[Math.floor(random() * ASIDE.length)];
      } else {
        text = topic.lines[Math.floor(random() * topic.lines.length)];
      }

      // Gaps are mostly short; a minority of block starts get a real pause.
      const gap = i === 0 && block > 0 && random() < 0.4
        ? 6_000 + Math.floor(random() * 9_000)
        : 400 + Math.floor(random() * 2_600);
      clock += gap;
      const duration = 1_200 + Math.floor(random() * 4_000);

      segments.push({
        tStartMs: clock,
        tEndMs: clock + duration,
        speaker: SPEAKERS[Math.floor(random() * SPEAKERS.length)],
        text,
      });
      topicOfUtterance.push(topicId);
      clock += duration;
    }
  });

  return { name, segments, topicOfUtterance };
}

/** The calibration set: recurrence, short blocks, many turns, and a single-topic control. */
export function buildCalibrationCases(): CalibrationCase[] {
  return [
    buildMeeting('recurring-subjects', [
      ['travel', 14], ['redis', 26], ['hiring', 20], ['redis', 16], ['travel', 12],
    ], 1001),
    buildMeeting('four-subjects-once', [
      ['redis', 22], ['travel', 18], ['hiring', 24], ['release', 20],
    ], 1002),
    buildMeeting('short-blocks', [
      ['redis', 9], ['hiring', 8], ['redis', 11], ['release', 7], ['travel', 10], ['release', 9],
    ], 1003),
    buildMeeting('long-single-subject', [['release', 48]], 1004),
    buildMeeting('two-way-alternation', [
      ['redis', 15], ['release', 13], ['redis', 14], ['release', 12], ['redis', 11],
    ], 1005),
  ];
}
