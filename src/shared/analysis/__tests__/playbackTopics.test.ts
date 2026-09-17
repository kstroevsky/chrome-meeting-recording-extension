import { toPlaybackTopics } from '../playbackTopics';
import { topicSeekMs } from '../../playback';
import type { ConversationSegment, Topic } from '../types';

const vector = Float32Array.from([1, 0]);

function topic(id: string, keywords: string[], importance: number): Topic {
  return { id, centroid: vector, segments: [], keywords, importance };
}

function segment(id: string, topicId: string, tStartMs: number, tEndMs: number): ConversationSegment {
  return {
    id,
    tStartMs,
    tEndMs,
    embedding: vector,
    localTopicId: topicId,
    startWindow: 0,
    endWindow: 1,
  };
}

describe('toPlaybackTopics', () => {
  it('gives a recurring topic one row with both of its spans (MODEL-04)', () => {
    const topics = toPlaybackTopics({
      topics: [topic('t_redis', ['redis', 'pool'], 0.9), topic('t_hiring', ['interview'], 0.4)],
      segments: [
        segment('s1', 't_redis', 0, 300_000),
        segment('s2', 't_hiring', 300_000, 900_000),
        segment('s3', 't_redis', 900_000, 1_200_000),
      ],
    });

    const redis = topics.find((t) => t.id === 't_redis')!;
    expect(redis.spans).toEqual([
      { tStartMs: 0, tEndMs: 300_000 },
      { tStartMs: 900_000, tEndMs: 1_200_000 },
    ]);
    // Summed, not last-minus-first: the ten minutes of hiring are not Redis.
    expect(redis.totalMs).toBe(600_000);
  });

  it('joins consecutive segments of one subject into a single span', () => {
    const [only] = toPlaybackTopics({
      topics: [topic('t1', ['redis'], 0.5)],
      segments: [
        segment('s1', 't1', 0, 60_000),
        segment('s2', 't1', 60_000, 120_000),
        segment('s3', 't1', 120_000, 180_000),
      ],
    });

    // Drawing three bands would invent boundaries the pipeline decided against.
    expect(only.spans).toEqual([{ tStartMs: 0, tEndMs: 180_000 }]);
    expect(only.totalMs).toBe(180_000);
  });

  it('merges overlapping spans without double-counting their time', () => {
    const [only] = toPlaybackTopics({
      topics: [topic('t1', ['redis'], 0.5)],
      segments: [segment('s1', 't1', 0, 120_000), segment('s2', 't1', 60_000, 180_000)],
    });

    expect(only.spans).toEqual([{ tStartMs: 0, tEndMs: 180_000 }]);
    expect(only.totalMs).toBe(180_000);
  });

  it('orders topics by importance, then by how much of the call they took', () => {
    const topics = toPlaybackTopics({
      topics: [
        topic('t_small', ['aside'], 0.5),
        topic('t_big', ['redis'], 0.5),
        topic('t_top', ['decision'], 0.9),
      ],
      segments: [
        segment('s1', 't_small', 0, 60_000),
        segment('s2', 't_big', 60_000, 600_000),
        segment('s3', 't_top', 600_000, 660_000),
      ],
    });

    expect(topics.map((t) => t.id)).toEqual(['t_top', 't_big', 't_small']);
  });

  it('drops a topic with no segments rather than showing a label that seeks nowhere', () => {
    const topics = toPlaybackTopics({
      topics: [topic('t_real', ['redis'], 0.5), topic('t_orphan', ['ghost'], 0.9)],
      segments: [segment('s1', 't_real', 0, 60_000)],
    });

    expect(topics.map((t) => t.id)).toEqual(['t_real']);
  });

  it('carries no vectors into the manifest', () => {
    const [only] = toPlaybackTopics({
      topics: [topic('t1', ['redis'], 0.5)],
      segments: [segment('s1', 't1', 0, 60_000)],
    });

    expect(Object.keys(only).sort()).toEqual(['id', 'importance', 'keywords', 'spans', 'totalMs']);
  });

  it('copies the keywords, so a caller cannot mutate the stored analysis', () => {
    const stored = topic('t1', ['redis'], 0.5);
    const [only] = toPlaybackTopics({ topics: [stored], segments: [segment('s1', 't1', 0, 1)] });

    only.keywords.push('tampered');
    expect(stored.keywords).toEqual(['redis']);
  });

  it('survives a segment whose end precedes its start', () => {
    const [only] = toPlaybackTopics({
      topics: [topic('t1', ['redis'], 0.5)],
      segments: [segment('s1', 't1', 60_000, 10_000)],
    });

    // Clamped rather than producing a negative duration that would render backwards.
    expect(only.spans).toEqual([{ tStartMs: 60_000, tEndMs: 60_000 }]);
    expect(only.totalMs).toBe(0);
  });

  it('answers nothing for an analysis that produced nothing', () => {
    expect(toPlaybackTopics({ topics: [], segments: [] })).toEqual([]);
  });
});

describe('topicSeekMs', () => {
  it('seeks to the first span, not the strongest one', () => {
    expect(topicSeekMs({
      id: 't1',
      keywords: [],
      spans: [{ tStartMs: 5_000, tEndMs: 9_000 }, { tStartMs: 90_000, tEndMs: 99_000 }],
      totalMs: 13_000,
      importance: 1,
    })).toBe(5_000);
  });
});
