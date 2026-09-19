import { tokenize, topicKeywords, topicLabels } from '../keywords';

const CONFIG = { keywordsPerTopic: 4 };
const scoredTerms = (documents: { id: string; text: string }[], id: string) =>
  (topicKeywords(documents).get(id) ?? []).map((k) => k.term);

describe('tokenize', () => {
  it('lowercases and splits on punctuation', () => {
    expect(tokenize('Redis, timeout! Workers?')).toEqual(['redis', 'timeout', 'workers']);
  });

  it('keeps non-Latin scripts rather than discarding them', () => {
    expect(tokenize('привет мир')).toEqual(['привет', 'мир']);
    expect(tokenize('日本語 テスト')).toEqual(['日本語', 'テスト']);
  });

  it('drops single characters as punctuation residue', () => {
    expect(tokenize('a pool of b workers')).toEqual(['pool', 'of', 'workers']);
  });

  it('keeps numbers, which carry meaning in a technical conversation', () => {
    expect(tokenize('scale to 500 workers')).toEqual(['scale', 'to', '500', 'workers']);
  });
});

describe('topicKeywords — the scoring surface', () => {
  const corpus = [
    { id: 'redis', text: 'the redis pool is saturated redis timeout workers pool redis timeout' },
    { id: 'berlin', text: 'the berlin hotel and the flight berlin hotel flight' },
    { id: 'hiring', text: 'the interview for the frontend candidate interview frontend' },
  ];

  it('ranks what distinguishes a topic above what it shares', () => {
    const terms = scoredTerms(corpus, 'redis');
    expect(terms[0]).toBe('redis');
    expect(terms.indexOf('redis')).toBeLessThan(terms.indexOf('the'));
  });

  it('keeps a universally used term available for scoring and search', () => {
    // Not filtered here: "the" earned a weight and stays addressable. Only the
    // label drops it.
    for (const id of ['redis', 'berlin', 'hiring']) {
      expect(scoredTerms(corpus, id)).toContain('the');
    }
  });

  it('returns every term rather than a capped list', () => {
    expect(scoredTerms(corpus, 'berlin').sort())
      .toEqual(['and', 'berlin', 'flight', 'hotel', 'the']);
  });

  it('breaks ties alphabetically so a read is reproducible', () => {
    const first = scoredTerms([{ id: 'a', text: 'zebra apple mango' }], 'a');
    const second = scoredTerms([{ id: 'a', text: 'mango zebra apple' }], 'a');
    expect(first).toEqual(second);
  });

  it('gives a topic with no usable text an empty list rather than dropping it', () => {
    const documents = [{ id: 'empty', text: '— . ,' }, { id: 'real', text: 'redis pool timeout' }];
    expect(topicKeywords(documents).has('empty')).toBe(true);
    expect(scoredTerms(documents, 'empty')).toEqual([]);
  });

  it('handles no topics at all', () => {
    expect(topicKeywords([]).size).toBe(0);
  });
});

describe('topicLabels — what names a topic on screen', () => {
  it('names each topic by what distinguishes it from the others', () => {
    const labels = topicLabels([
      { id: 'redis', text: 'the redis pool is saturated redis timeout workers pool redis timeout' },
      { id: 'berlin', text: 'the berlin hotel and the flight berlin hotel flight' },
      { id: 'hiring', text: 'the interview for the frontend candidate interview frontend' },
    ], CONFIG);

    expect(labels.get('redis')).toEqual(expect.arrayContaining(['redis', 'timeout']));
    expect(labels.get('berlin')).toEqual(expect.arrayContaining(['berlin', 'hotel', 'flight']));
    expect(labels.get('hiring')).toEqual(expect.arrayContaining(['interview', 'frontend', 'candidate']));
  });

  it('makes a universally used term impossible in a label', () => {
    // `● redis · pool · timeout · the` is exactly the label UI-02 must not
    // produce. "the" occurs in all three topics, so it has no power to tell one
    // from another — no stopword dictionary and no threshold involved.
    const labels = topicLabels([
      { id: 'a', text: 'the redis pool the redis timeout' },
      { id: 'b', text: 'the berlin hotel the berlin flight' },
      { id: 'c', text: 'the interview frontend the interview candidate' },
    ], CONFIG);

    for (const id of ['a', 'b', 'c']) expect(labels.get(id)).not.toContain('the');
  });

  it('does the same for a non-English filler word', () => {
    const labels = topicLabels([
      { id: 'a', text: 'это redis пул это redis таймаут' },
      { id: 'b', text: 'это берлин отель это берлин рейс' },
    ], { keywordsPerTopic: 3 });

    expect(labels.get('a')).not.toContain('это');
    expect(labels.get('a')).toContain('redis');
    expect(labels.get('b')).toContain('берлин');
  });

  it('drops a shared term even when it is a topic’s most frequent word', () => {
    const labels = topicLabels([
      { id: 'a', text: 'deploy deploy deploy redis' },
      { id: 'b', text: 'deploy deploy deploy berlin' },
    ], { keywordsPerTopic: 2 });

    expect(labels.get('a')).toEqual(['redis']);
    expect(labels.get('b')).toEqual(['berlin']);
  });

  it('keeps everything when there is only one topic to name', () => {
    // Nothing to be distinguished from, so the rule does not apply.
    const labels = topicLabels([{ id: 'only', text: 'the redis the redis pool' }], { keywordsPerTopic: 3 });
    expect(labels.get('only')?.[0]).toBe('redis');
    expect(labels.get('only')).toContain('the');
  });

  it('leaves two indistinguishable topics with empty labels rather than inventing one', () => {
    // If nothing separates them, no word can be shown that does — and that is a
    // signal clustering split something it should not have.
    const labels = topicLabels([
      { id: 'a', text: 'redis pool timeout' },
      { id: 'b', text: 'redis pool timeout' },
    ], CONFIG);

    expect(labels.get('a')).toEqual([]);
    expect(labels.get('b')).toEqual([]);
  });

  it('caps the label after filtering, not before', () => {
    // "the" would otherwise occupy one of the two slots.
    const labels = topicLabels([
      { id: 'a', text: 'the redis the pool the timeout' },
      { id: 'b', text: 'the berlin the hotel the flight' },
    ], { keywordsPerTopic: 2 });

    expect(labels.get('a')).toHaveLength(2);
    expect(labels.get('a')).not.toContain('the');
  });

  it('refuses a nonsense keyword count', () => {
    expect(() => topicLabels([{ id: 'a', text: 'x' }], { keywordsPerTopic: 0 }))
      .toThrow(/at least one keyword/);
  });
});
