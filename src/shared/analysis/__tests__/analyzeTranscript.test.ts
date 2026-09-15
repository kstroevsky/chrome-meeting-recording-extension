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
