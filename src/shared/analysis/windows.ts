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
import {
  startsWithDiscourseCue,
  type AnalysisSourceSpan,
  type ContextWindow,
  type SegmentationConfig,
} from './types';

/** SEG-02 bounds a window to this many utterances on either side of a boundary. */
const MIN_WINDOW_UTTERANCES = 3;
const MAX_WINDOW_UTTERANCES = 5;

export type WindowConfig = Pick<SegmentationConfig, 'windowUtterances' | 'windowStride'>;

/**
 * Builds the contextual windows for a transcript.
 *
 * **Adjacent windows must not share utterances.** ADR-0007's 4B calibration
 * established this the hard way: an earlier build let the boundary contexts
 * overlap, and the shared text smeared the very signal they exist to measure —
 * adjacent within-topic windows scored 0.954 against 0.946 across a real
 * boundary. Making them disjoint took boundary F1 from 0.767 to 0.892. The
 * calibrated configuration therefore runs stride **equal to** the window.
 *
 * A shorter stride remains expressible, because SEG-02 describes the contexts
 * compared across a boundary rather than the windows themselves, and a future
 * higher-resolution detector may want to slide a disjoint *pair* across every
 * position. But nothing should reach for it casually: with the current
 * detector, overlap is the failure mode above.
 *
 * Every utterance lands in at least one window. A transcript shorter than one
 * window still yields a single window covering it, and a trailing remainder the
 * stride would otherwise skip gets a **short** window of its own — a
 * conversation must not lose its last few turns to arithmetic, and must not
 * gain a duplicated tail either.
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

  // The stride can step past the tail without covering it. Cover exactly the
  // remainder — `[covered, end)` — rather than anchoring a full-size window at
  // `length - windowUtterances`, which is what this used to do and which
  // overlapped its predecessor by `windowUtterances - remainder` utterances.
  // At the calibrated 4/4 over ten turns that produced [0,4) [4,8) [6,10): two
  // shared utterances between the last pair, reintroducing exactly the smearing
  // 4B had just eliminated.
  //
  // The tail is therefore shorter than SEG-02's 3–5 when the remainder is, and
  // that is the right trade: a thin final window costs one boundary a little
  // context, while a duplicated one corrupts the comparison either side of it.
  const covered = windows[windows.length - 1]?.endIndex ?? 0;
  if (covered < segments.length) {
    windows.push(toWindow(segments, covered, segments.length));
  }
  return windows;
}

function toWindow(segments: TranscriptSegment[], startIndex: number, endIndex: number): ContextWindow {
  const sourceSpans: AnalysisSourceSpan[] = [];
  for (let segmentIndex = startIndex; segmentIndex < endIndex; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    sourceSpans.push({
      segmentIndex,
      textStart: 0,
      textEnd: segment.text.length,
      tStartMs: segment.tStartMs,
      tEndMs: segment.tEndMs,
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
      timingFidelity: 'segment',
    });
  }
  return contextWindowFromSourceSpans(segments, sourceSpans);
}

/** Builds one derived window from explicit canonical source coverage. */
export function contextWindowFromSourceSpans(
  segments: TranscriptSegment[],
  sourceSpans: AnalysisSourceSpan[],
  tokenLength?: number,
): ContextWindow {
  if (!sourceSpans.length) throw new Error('A contextual window must cover at least one source span');
  const speakers: string[] = [];
  let opensWithDiscourseCue = false;
  let tStartMs = Number.POSITIVE_INFINITY;
  let tEndMs = Number.NEGATIVE_INFINITY;
  const textParts: string[] = [];
  let previous: AnalysisSourceSpan | undefined;
  for (const span of sourceSpans) {
    const segment = segments[span.segmentIndex];
    if (!segment) throw new Error(`Analysis source span references missing segment ${span.segmentIndex}`);
    if (span.textStart < 0 || span.textEnd > segment.text.length || span.textEnd <= span.textStart) {
      throw new Error(`Analysis source span is outside segment ${span.segmentIndex}`);
    }
    const part = segment.text.slice(span.textStart, span.textEnd);
    if (previous && previous.segmentIndex !== span.segmentIndex) textParts.push(' ');
    textParts.push(part);
    if (span.speaker && !speakers.includes(span.speaker)) speakers.push(span.speaker);
    if (!opensWithDiscourseCue && span.textStart === 0 && startsWithDiscourseCue(part)) {
      opensWithDiscourseCue = true;
    }
    tStartMs = Math.min(tStartMs, span.tStartMs);
    tEndMs = Math.max(tEndMs, span.tEndMs);
    previous = span;
  }

  return {
    startIndex: sourceSpans[0].segmentIndex,
    endIndex: sourceSpans[sourceSpans.length - 1].segmentIndex + 1,
    tStartMs,
    tEndMs,
    text: textParts.join(''),
    sourceSpans: sourceSpans.map((span) => ({ ...span })),
    ...(tokenLength != null ? { tokenLength } : {}),
    speakers,
    opensWithDiscourseCue,
  };
}
