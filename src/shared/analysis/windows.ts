/**
 * @file shared/analysis/windows.ts
 *
 * Groups transcript utterances into the contextual windows that actually get
 * encoded.
 *
 * A window is 3–5 consecutive utterances, which is the same span SEG-02 asks
 * for on either side of a candidate boundary — so one pass of the encoder
 * serves both boundary detection and clustering, which is how ARCH-03's diagram
 * branches them. It is also what makes the sizing work out: 1,000–3,000 turns
 * at roughly four utterances per window is the 300–800 windows EMB-06 predicts,
 * which is the difference between this being affordable in a browser and not.
 */

import type { TranscriptSegment } from '../transcript';
import { startsWithDiscourseCue, type ContextWindow, type SegmentationConfig } from './types';

/** SEG-02 bounds a window to this many utterances on either side of a boundary. */
const MIN_WINDOW_UTTERANCES = 3;
const MAX_WINDOW_UTTERANCES = 5;

export type WindowConfig = Pick<SegmentationConfig, 'windowUtterances' | 'windowStride'>;

/**
 * Builds the contextual windows for a transcript.
 *
 * Windows overlap when the stride is shorter than the window, which is the
 * point: adjacent windows share context, so the cosine change between them
 * reflects a shift in subject rather than the accident of where a window
 * happened to start.
 *
 * Every utterance lands in at least one window. A transcript shorter than one
 * window still yields a single window covering it, and a trailing remainder the
 * stride would otherwise skip gets a final window of its own — a conversation
 * must not lose its last few turns to arithmetic.
 */
export function buildContextWindows(
  segments: TranscriptSegment[],
  config: WindowConfig,
): ContextWindow[] {
  const { windowUtterances, windowStride } = config;
  if (!Number.isInteger(windowUtterances)
    || windowUtterances < MIN_WINDOW_UTTERANCES
    || windowUtterances > MAX_WINDOW_UTTERANCES) {
    throw new Error(
      `A contextual window must be ${MIN_WINDOW_UTTERANCES}–${MAX_WINDOW_UTTERANCES} utterances (SEG-02), not ${windowUtterances}`,
    );
  }
  if (!Number.isInteger(windowStride) || windowStride < 1 || windowStride > windowUtterances) {
    throw new Error(`A window stride must be between 1 and the window size, not ${windowStride}`);
  }
  if (!segments.length) return [];

  const windows: ContextWindow[] = [];
  const lastStart = Math.max(0, segments.length - windowUtterances);
  for (let start = 0; start <= lastStart; start += windowStride) {
    windows.push(toWindow(segments, start, Math.min(start + windowUtterances, segments.length)));
  }

  // The stride can step past the tail without covering it. One more window,
  // anchored at the end, rather than dropping the conversation's last turns.
  const covered = windows[windows.length - 1]?.endIndex ?? 0;
  if (covered < segments.length) {
    windows.push(toWindow(segments, Math.max(0, segments.length - windowUtterances), segments.length));
  }
  return windows;
}

function toWindow(segments: TranscriptSegment[], startIndex: number, endIndex: number): ContextWindow {
  const covered = segments.slice(startIndex, endIndex);
  const speakers: string[] = [];
  let opensWithDiscourseCue = false;
  for (const segment of covered) {
    if (segment.speaker && !speakers.includes(segment.speaker)) speakers.push(segment.speaker);
    if (!opensWithDiscourseCue && startsWithDiscourseCue(segment.text)) opensWithDiscourseCue = true;
  }

  return {
    startIndex,
    endIndex,
    tStartMs: covered[0].tStartMs,
    tEndMs: covered[covered.length - 1].tEndMs,
    text: covered.map((segment) => segment.text).join(' '),
    speakers,
    opensWithDiscourseCue,
  };
}
