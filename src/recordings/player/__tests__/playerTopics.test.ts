import { describeTopics, recurrenceHint, topicCount } from '../playerTopics';
import { formatTopicDuration, toTopicBands, topicLabel, TOPIC_SHADES } from '../playerFormat';
import type { PlaybackTopic } from '../../../shared/playback';

function topic(id: string, keywords: string[], spans: Array<[number, number]>): PlaybackTopic {
  return {
    id,
    keywords,
    spans: spans.map(([tStartMs, tEndMs]) => ({ tStartMs, tEndMs })),
    totalMs: spans.reduce((total, [start, end]) => total + (end - start), 0),
    importance: 0.5,
  };
}

describe('topicLabel', () => {
  it('renders UI-02 exactly', () => {
    expect(topicLabel({ keywords: ['redis', 'timeout', 'workers', 'pool'] }))
      .toBe('redis · timeout · workers · pool');
  });

  it('names a topic c-TF-IDF could not label', () => {
    expect(topicLabel({ keywords: [] })).toBe('Untitled topic');
  });
});

describe('formatTopicDuration', () => {
  it('reports whole minutes', () => {
    expect(formatTopicDuration(23 * 60_000)).toBe('23 min');
    expect(formatTopicDuration(90_000)).toBe('2 min');
  });

  it('says less than a minute rather than zero', () => {
    expect(formatTopicDuration(20_000)).toBe('< 1 min');
  });

  it('breaks an hour out', () => {
    expect(formatTopicDuration(65 * 60_000)).toBe('1 h 5 min');
    expect(formatTopicDuration(120 * 60_000)).toBe('2 h');
  });

  it('survives a duration that is not a number', () => {
    expect(formatTopicDuration(Number.NaN)).toBe('0 min');
    expect(formatTopicDuration(-1)).toBe('0 min');
  });
});

describe('describeTopics', () => {
  it("builds UI-02 rows in the manifest's order", () => {
    const rows = describeTopics([
      topic('t1', ['redis', 'timeout', 'workers', 'pool'], [[0, 23 * 60_000]]),
      topic('t2', ['berlin', 'hotel', 'flight'], [[23 * 60_000, 35 * 60_000]]),
    ]);

    expect(rows.map((r) => `${r.label}  ${r.duration}`)).toEqual([
      'redis · timeout · workers · pool  23 min',
      'berlin · hotel · flight  12 min',
    ]);
  });

  it('seeks a recurring topic to where it first came up', () => {
    const [row] = describeTopics([topic('t1', ['redis'], [[60_000, 120_000], [600_000, 700_000]])]);
    expect(row.seekMs).toBe(60_000);
    expect(row.spanCount).toBe(2);
  });

  it('gives a row the same shade as its bands', () => {
    const topics = [
      topic('t1', ['a'], [[0, 1_000]]),
      topic('t2', ['b'], [[1_000, 2_000]]),
    ];
    const rows = describeTopics(topics);
    const bands = toTopicBands(topics, 2_000);

    for (const row of rows) {
      const band = bands.find((b) => b.topicId === row.id)!;
      expect(band.shade).toBe(row.shade);
    }
  });

  it('cycles shades past the palette rather than running off the end', () => {
    const many = Array.from({ length: TOPIC_SHADES + 2 }, (_, i) =>
      topic(`t${i}`, [`k${i}`], [[i * 1_000, i * 1_000 + 500]]));
    const shades = describeTopics(many).map((r) => r.shade);

    expect(Math.min(...shades)).toBe(0);
    expect(Math.max(...shades)).toBe(TOPIC_SHADES - 1);
    // The fifth topic wraps back to the first shade; the label disambiguates.
    expect(shades[TOPIC_SHADES]).toBe(0);
  });

  it('counts what the trigger shows', () => {
    expect(topicCount(describeTopics([]))).toBe(0);
    expect(topicCount(describeTopics([topic('t1', ['a'], [[0, 1]])]))).toBe(1);
  });
});

describe('recurrenceHint', () => {
  it('marks only a topic the conversation came back to', () => {
    expect(recurrenceHint({ spanCount: 1 })).toBe('');
    expect(recurrenceHint({ spanCount: 2 })).toBe('2×');
    expect(recurrenceHint({ spanCount: 5 })).toBe('5×');
  });
});

describe('toTopicBands', () => {
  it('lays every span out in time order across topics', () => {
    const bands = toTopicBands([
      topic('t_redis', ['redis'], [[0, 300_000], [900_000, 1_200_000]]),
      topic('t_hiring', ['interview'], [[300_000, 900_000]]),
    ], 1_200_000);

    expect(bands.map((b) => b.topicId)).toEqual(['t_redis', 't_hiring', 't_redis']);
    expect(bands.map((b) => Math.round(b.leftPct))).toEqual([0, 25, 75]);
  });

  it('keeps one shade for a topic across all of its spans (MODEL-04)', () => {
    const bands = toTopicBands([
      topic('t_redis', ['redis'], [[0, 300_000], [900_000, 1_200_000]]),
      topic('t_hiring', ['interview'], [[300_000, 900_000]]),
    ], 1_200_000);

    const redis = bands.filter((b) => b.topicId === 't_redis');
    expect(redis[0].shade).toBe(redis[1].shade);
    expect(bands.find((b) => b.topicId === 't_hiring')!.shade).not.toBe(redis[0].shade);
  });

  it('gives a topic too short to see a hittable minimum width', () => {
    const [band] = toTopicBands([topic('t1', ['a'], [[0, 200]])], 3_600_000);
    expect(band.widthPct).toBeGreaterThan(0.5);
  });

  it('never lets a band run past the end of the track', () => {
    const bands = toTopicBands([topic('t1', ['a'], [[0, 999_000_000]])], 60_000);
    expect(bands[0].leftPct + bands[0].widthPct).toBeLessThanOrEqual(100);
  });

  it('clamps a span that starts past the recording', () => {
    const [band] = toTopicBands([topic('t1', ['a'], [[90_000, 120_000]])], 60_000);
    expect(band.leftPct).toBe(100);
    expect(band.startMs).toBe(60_000);
  });

  it('draws nothing when the duration is unknown', () => {
    expect(toTopicBands([topic('t1', ['a'], [[0, 1_000]])], 0)).toEqual([]);
    expect(toTopicBands([topic('t1', ['a'], [[0, 1_000]])], Number.NaN)).toEqual([]);
  });
});
