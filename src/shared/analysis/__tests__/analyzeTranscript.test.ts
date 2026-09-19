import { EMBEDDING_BATCH_SIZE, analyzeTranscript } from '../analyzeTranscript';
import type { AnalysisConfig } from '../types';
import type { TranscriptSegment } from '../../transcript';

/**
 * A stub encoder with a real property: text about the same subject points the
 * same way. Enough to exercise every stage above the encoder, which is the
 * point of injecting it (ARCH-04).
 */
const SUBJECTS: Record<string, number> = { redis: 0, berlin: 90, hiring: 180, release: 270 };

const encode = async (texts: string[]): Promise<Float32Array[]> => texts.map((text) => {
  const subject = Object.keys(SUBJECTS).find((s) => text.includes(s)) ?? 'redis';
  const rad = (SUBJECTS[subject] * Math.PI) / 180;
  return Float32Array.from([Math.cos(rad), Math.sin(rad)]);
});

const CONFIG: AnalysisConfig = {
  windowUtterances: 4,
  windowStride: 4,
  longPauseMs: 3_000,
  peakNeighbourhood: 2,
  peakMinProminence: 0.05,
  minSegmentMs: 1_000,
  assignmentThreshold: 0.93,
  mergeThreshold: 0.95,
  mergeEverySegments: 12,
  keywordsPerTopic: 3,
};

/** Builds a transcript from a schedule of `[subject, utterances]` blocks. */
const transcriptOf = (schedule: [string, number][]): TranscriptSegment[] => {
  const segments: TranscriptSegment[] = [];
  let clock = 0;
  for (const [subject, count] of schedule) {
    for (let i = 0; i < count; i += 1) {
      segments.push({
        tStartMs: clock,
        tEndMs: clock + 2_000,
        speaker: i % 2 ? 'Ada' : 'Grace',
        text: `${subject} pool timeout discussion number ${i}`,
      });
      clock += 3_000;
    }
  }
  return segments;
};

describe('analyzeTranscript', () => {
  it('turns a conversation into segments and topics', async () => {
    const result = await analyzeTranscript(
      transcriptOf([['redis', 12], ['berlin', 12], ['hiring', 12]]),
      CONFIG,
      encode,
    );

    expect(result.utteranceCount).toBe(36);
    expect(result.topics.length).toBeGreaterThan(1);
    // Every segment names a topic that exists — the invariant the stored row
    // refuses to persist without.
    const known = new Set(result.topics.map((t) => t.id));
    for (const segment of result.segments) expect(known.has(segment.localTopicId)).toBe(true);
  });

  it('reunites a subject that comes back later (MODEL-04)', async () => {
    const result = await analyzeTranscript(
      transcriptOf([['redis', 12], ['berlin', 12], ['redis', 12]]),
      CONFIG,
      encode,
    );

    // Three stretches, two subjects: the recurrence is the whole point of
    // separating temporal segments from global topics.
    expect(result.topics).toHaveLength(2);
    const redis = result.topics.find((t) => t.keywords.includes('redis'));
    expect(redis!.segments.length).toBeGreaterThan(1);
  });

  it('labels each topic from the words its own segments cover', async () => {
    const result = await analyzeTranscript(
      transcriptOf([['redis', 12], ['berlin', 12]]),
      CONFIG,
      encode,
    );

    const labels = result.topics.map((t) => t.keywords);
    expect(labels.some((l) => l.includes('redis'))).toBe(true);
    expect(labels.some((l) => l.includes('berlin'))).toBe(true);
    // "pool", "timeout" and "discussion" appear in every topic, so they cannot
    // distinguish one label from another (KW-01).
    for (const l of labels) expect(l).not.toContain('discussion');
  });

  it('scores every topic and carries its window coverage', async () => {
    const result = await analyzeTranscript(
      transcriptOf([['redis', 12], ['berlin', 12]]),
      CONFIG,
      encode,
    );

    for (const topic of result.topics) {
      expect(topic.importance).toBeGreaterThan(0);
      expect(topic.importance).toBeLessThanOrEqual(1);
    }
    for (const segment of result.segments) {
      expect(segment.endWindow).toBeGreaterThan(segment.startWindow);
    }
  });

  it('encodes in batches of 32, the production size', async () => {
    const sizes: number[] = [];
    const counted = async (texts: string[]) => { sizes.push(texts.length); return encode(texts); };

    await analyzeTranscript(transcriptOf([['redis', 200]]), CONFIG, counted);

    expect(EMBEDDING_BATCH_SIZE).toBe(32);
    expect(sizes.slice(0, -1).every((n) => n === 32)).toBe(true);
    expect(sizes[sizes.length - 1]).toBeLessThanOrEqual(32);
  });

  it('reports progress as windows are encoded', async () => {
    const seen: { windowsEncoded: number; windowsTotal: number }[] = [];
    await analyzeTranscript(
      transcriptOf([['redis', 200]]),
      CONFIG,
      encode,
      { onProgress: (p) => seen.push(p) },
    );

    expect(seen.length).toBeGreaterThan(1);
    expect(seen[seen.length - 1].windowsEncoded).toBe(seen[seen.length - 1].windowsTotal);
    // Monotonic, so a progress bar cannot go backwards.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i].windowsEncoded).toBeGreaterThan(seen[i - 1].windowsEncoded);
    }
  });

  it('stops at the next batch boundary when cancelled', async () => {
    const signal = { aborted: false };
    let batches = 0;
    const cancelAfterTwo = async (texts: string[]) => {
      batches += 1;
      if (batches === 2) signal.aborted = true;
      return encode(texts);
    };

    await expect(analyzeTranscript(transcriptOf([['redis', 400]]), CONFIG, cancelAfterTwo, { signal }))
      .rejects.toThrow(/cancelled/);
    expect(batches).toBe(2);
  });

  it('returns nothing for a transcript too short to window, rather than failing', async () => {
    await expect(analyzeTranscript([], CONFIG, encode))
      .resolves.toEqual({ segments: [], topics: [], utteranceCount: 0 });
  });

  it('refuses an encoder that returns the wrong number of vectors', async () => {
    const short = async (texts: string[]) => (await encode(texts)).slice(0, -1);
    await expect(analyzeTranscript(transcriptOf([['redis', 12]]), CONFIG, short))
      .rejects.toThrow(/returned \d+ vectors for \d+ windows/);
  });
});

describe('topic importance ranks against the cluster centroid (IMP-02)', () => {
  /**
   * The bug this pins: importance used to rank a topic's passages against the
   * **first segment's embedding** rather than the cluster centroid. That scores
   * a topic by how much it resembles its own opening, and is worst exactly
   * where global topics earn their keep — for a subject the conversation
   * returns to, the later stretches are penalised for differing from the first.
   *
   * The invariant is **order independence**: the same two stretches of one
   * subject must score the same whichever came first, because the centroid is
   * the same set either way. Ranking against `segments[0]` makes the answer
   * depend on transcript order.
   *
   * Two fixture properties are load-bearing, and both were arrived at by
   * finding weaker versions that passed with the bug still in place:
   *
   *  - the stretches must be **unequal in size**, or the mean similarity to
   *    either endpoint is identical by symmetry and the bug hides;
   *  - they must be **far enough apart** that the 0.30 similarity term moves
   *    the 0.30/0.25/0.20/0.15/0.10 blend measurably.
   *
   * With the bug, this fixture reads 0.5168 one way and 0.4817 the other.
   */
  const leaning = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return Float32Array.from([Math.cos(rad), Math.sin(rad)]);
  };

  const encodeLeaning = async (texts: string[]): Promise<Float32Array[]> => texts.map((text) => {
    if (text.includes('early')) return leaning(0);
    if (text.includes('late')) return leaning(40);
    return leaning(140);
  });

  const runOf = (schedule: Array<[string, number]>): TranscriptSegment[] => {
    const segments: TranscriptSegment[] = [];
    let clock = 0;
    for (const [tag, count] of schedule) {
      for (let i = 0; i < count; i += 1) {
        segments.push({ tStartMs: clock, tEndMs: clock + 2_000, speaker: 'Ada', text: `${tag} pool timeout ${i}` });
        clock += 3_000;
      }
    }
    return segments;
  };

  it('gives the same importance whichever stretch of a topic came first', async () => {
    // Thresholds loose enough for two distant stretches to reunite, and a merge
    // period short enough for the sweep to run on a fixture this size.
    const config = {
      ...CONFIG,
      assignmentThreshold: 0.6,
      mergeThreshold: 0.6,
      mergeEverySegments: 2,
      minSegmentMs: 1_000,
    };
    const sizes: Record<string, number> = { early: 24, late: 8 };

    const analyse = async (first: 'early' | 'late', second: 'early' | 'late') =>
      analyzeTranscript(runOf([[first, sizes[first]], ['other', 12], [second, sizes[second]]]), config, encodeLeaning);

    const forward = await analyse('early', 'late');
    const reversed = await analyse('late', 'early');

    const recurring = (result: { topics: Array<{ segments: string[]; importance: number }> }) =>
      [...result.topics].sort((a, b) => b.segments.length - a.segments.length)[0];

    const a = recurring(forward);
    const b = recurring(reversed);
    // The fixture has to actually produce a recurrent topic, or it proves nothing.
    expect(a.segments.length).toBe(2);
    expect(b.segments.length).toBe(2);
    expect(a.importance).toBeCloseTo(b.importance, 6);
  });
});
