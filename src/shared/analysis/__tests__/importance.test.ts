import {
  DISCOURSE_SIGNALS,
  IMPORTANCE_WEIGHTS,
  discourseSignal,
  keywordDistinctiveness,
  novelty,
  rankPassages,
  recurrence,
  selectRepresentative,
  similarityToTopic,
  type Passage,
} from '../importance';

const at = (deg: number): Float32Array => {
  const r = (deg * Math.PI) / 180;
  return Float32Array.from([Math.cos(r), Math.sin(r)]);
};

let seq = 0;
const passage = (deg: number, text = 'words', id = `p${(seq += 1)}`): Passage =>
  ({ id, tStartMs: 0, tEndMs: 1_000, text, embedding: at(deg) });

beforeEach(() => { seq = 0; });

describe('the ranking weights', () => {
  it('are IMP-03’s exact values and sum to 1', () => {
    expect(IMPORTANCE_WEIGHTS).toEqual({
      similarityToTopic: 0.30,
      novelty: 0.25,
      keywordDistinctiveness: 0.20,
      recurrence: 0.15,
      discourseSignal: 0.10,
    });
    const total = Object.values(IMPORTANCE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
  });
});

describe('the individual terms', () => {
  it('scores how squarely a passage sits in its topic', () => {
    expect(similarityToTopic(passage(0), at(0))).toBeCloseTo(1);
    expect(similarityToTopic(passage(90), at(0))).toBeCloseTo(0);
    // Pointing away is simply "not similar", not a negative contribution.
    expect(similarityToTopic(passage(180), at(0))).toBe(0);
  });

  it('scores the first passage as wholly novel and a repeat as not', () => {
    expect(novelty(passage(0), [])).toBe(1);
    expect(novelty(passage(0), [passage(0)])).toBeCloseTo(0);
    expect(novelty(passage(90), [passage(0)])).toBeCloseTo(1);
  });

  it('measures how much of a passage is the topic’s own vocabulary', () => {
    expect(keywordDistinctiveness(passage(0, 'redis pool timeout workers'), ['redis', 'pool']))
      .toBeCloseTo(0.5);
    expect(keywordDistinctiveness(passage(0, 'nothing relevant here'), ['redis'])).toBe(0);
    expect(keywordDistinctiveness(passage(0, 'redis'), [])).toBe(0);
    expect(keywordDistinctiveness(passage(0, ''), ['redis'])).toBe(0);
  });

  it('scores a point the conversation circles back to above a one-off aside', () => {
    const circled = passage(0);
    const siblings = [circled, passage(2), passage(3), passage(90)];
    const aside = siblings[3];

    expect(recurrence(circled, siblings)).toBeGreaterThan(recurrence(aside, siblings));
    // A topic with a single passage has nothing to recur against.
    expect(recurrence(circled, [circled])).toBe(0);
  });

  it('spots a decision marker anywhere in the passage', () => {
    expect(discourseSignal(passage(0, 'I think we should shard the pool'))).toBe(1);
    expect(discourseSignal(passage(0, 'so the problem is the connection limit'))).toBe(1);
    expect(discourseSignal(passage(0, "We agreed to revisit it"))).toBe(1);
    expect(discourseSignal(passage(0, 'nothing consequential here'))).toBe(0);
  });

  it('accepts a curly apostrophe, which is what a caption actually contains', () => {
    expect(discourseSignal(passage(0, 'Let’s do the migration first'))).toBe(1);
    expect(discourseSignal(passage(0, 'I’ll take that one'))).toBe(1);
  });

  it('requires a word boundary before the phrase', () => {
    expect(discourseSignal(passage(0, 'bewe agreed'))).toBe(0);
  });

  it('covers every phrase IMP-04 lists', () => {
    for (const phrase of DISCOURSE_SIGNALS) {
      expect(discourseSignal(passage(0, `and then ${phrase} something`))).toBe(1);
    }
  });
});

describe('rankPassages', () => {
  const topic = { centroid: at(0), keywords: ['redis', 'pool'] };

  it('blends the five terms at the exact IMP-03 weights', () => {
    // One passage: squarely on topic, wholly novel, all keywords, no siblings
    // to recur against, and carrying a decision marker.
    const [scored] = rankPassages([passage(0, "i'll redis pool")], topic);

    expect(scored.similarityToTopic).toBeCloseTo(1);
    expect(scored.novelty).toBe(1);
    expect(scored.recurrence).toBe(0);
    expect(scored.discourseSignal).toBe(1);
    expect(scored.importance).toBeCloseTo(
      0.30 * scored.similarityToTopic
      + 0.25 * scored.novelty
      + 0.20 * scored.keywordDistinctiveness
      + 0.15 * scored.recurrence
      + 0.10 * scored.discourseSignal,
    );
  });

  it('degrades to 0.30/0.25/0.20/0.15/0.00 on a passage with no marker', () => {
    // The English-only signal set contributes nothing on a non-English call.
    const [scored] = rankPassages([passage(0, 'это про redis')], topic);
    expect(scored.discourseSignal).toBe(0);
    expect(scored.importance).toBeLessThan(1);
  });

  it('reads novelty against what came before, so order is the conversation’s', () => {
    const scored = rankPassages([passage(0), passage(0), passage(90)], topic);
    expect(scored[0].novelty).toBe(1);
    expect(scored[1].novelty).toBeCloseTo(0);
    expect(scored[2].novelty).toBeCloseTo(1);
  });

  it('ranks a consequential on-topic passage above an off-topic aside', () => {
    const scored = rankPassages([
      passage(0, "i think we should resize the redis pool"),
      passage(90, 'unrelated chatter'),
    ], topic);
    expect(scored[0].importance).toBeGreaterThan(scored[1].importance);
  });

  it('handles a topic with no passages', () => {
    expect(rankPassages([], topic)).toEqual([]);
  });
});

describe('selectRepresentative (MMR)', () => {
  const topic = { centroid: at(0), keywords: [] as string[] };
  const config = { mmrLambda: 0.5 };

  it('refuses to pick the same point twice', () => {
    // Three near-restatements and one genuinely different passage.
    const scored = rankPassages(
      [passage(0, 'a'), passage(1, 'b'), passage(2, 'c'), passage(90, 'd')],
      topic,
    );
    const chosen = selectRepresentative(scored, 2, config);

    expect(chosen).toHaveLength(2);
    // The second pick covers new ground rather than restating the first.
    expect(Math.abs(chosen[0].embedding[1] - chosen[1].embedding[1])).toBeGreaterThan(0.5);
  });

  it('ignores redundancy entirely at lambda 1', () => {
    const scored = rankPassages([passage(0, 'a'), passage(1, 'b'), passage(90, 'd')], topic);
    const chosen = selectRepresentative(scored, 2, { mmrLambda: 1 });
    const byImportance = [...scored].sort((a, b) => b.importance - a.importance).slice(0, 2);
    expect(chosen.map((p) => p.id)).toEqual(byImportance.map((p) => p.id));
  });

  it('ignores importance entirely at lambda 0, taking the most different', () => {
    const scored = rankPassages([passage(0, 'a'), passage(1, 'b'), passage(90, 'd')], topic);
    const chosen = selectRepresentative(scored, 2, { mmrLambda: 0 });
    expect(chosen[1].id).toBe('p3');
  });

  it('returns everything when asked for more than exists', () => {
    const scored = rankPassages([passage(0), passage(90)], topic);
    expect(selectRepresentative(scored, 5, config)).toHaveLength(2);
    expect(selectRepresentative([], 3, config)).toEqual([]);
  });

  it('is reproducible, breaking ties towards the earlier passage', () => {
    const scored = rankPassages([passage(0, 'x'), passage(0, 'x')], topic);
    expect(selectRepresentative(scored, 1, config)[0].id)
      .toBe(selectRepresentative(scored, 1, config)[0].id);
  });

  it('refuses a nonsense lambda or count', () => {
    const scored = rankPassages([passage(0)], topic);
    expect(() => selectRepresentative(scored, 1, { mmrLambda: 1.5 })).toThrow(/lambda/);
    expect(() => selectRepresentative(scored, 0, config)).toThrow(/at least one/);
  });
});
