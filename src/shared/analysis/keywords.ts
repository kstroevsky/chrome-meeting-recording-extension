/**
 * @file shared/analysis/keywords.ts
 *
 * Class-based TF-IDF: what actually names a topic.
 *
 * With generation deferred (`docs/plans/local-text-processing.md` §12), this is
 * not a placeholder for a model — it is the entire labelling mechanism, and the
 * thing a user reads before deciding whether a recording is worth opening
 * (UI-01, UI-02). `● redis · timeout · workers · pool` comes from here.
 *
 * **c-TF-IDF treats each topic as one document.** Ordinary TF-IDF over
 * utterances would rank terms within a single turn, which says nothing about
 * what a topic is *about*. Pooling a topic's text and scoring against the other
 * topics asks the useful question instead: which words does this subject use
 * that the rest of the conversation does not?
 *
 * ```text
 * W(t,c) = tf(t,c) · log(1 + A / f(t))
 * ```
 *
 * where `tf(t,c)` is term `t`'s share of topic `c`'s words, `A` the average
 * topic length, and `f(t)` the term's count across every topic.
 *
 * **No stopword list, deliberately.** One would have to be per-language, and
 * the encoder is multilingual by design (EMB-03) — an English list would leave
 * every other language's filler words scoring as keywords, which is worse than
 * the asymmetry already recorded for SEG-06's cues. The `log(1 + A/f(t))` term
 * does the suppression instead: a word used evenly across every topic earns
 * strictly less than a distinctive one, in any language.
 *
 * That suppression is relative, not absolute — `log(1 + A/f(t))` never reaches
 * zero, unlike classical `log(N/df)` — so with only two or three topics a
 * ubiquitous word ranks last but can still reach a short list.
 *
 * **The fix lives at presentation, not in the formula.** {@link topicKeywords}
 * scores every term and is the surface for search and for scoring; a term used
 * everywhere keeps whatever weight it earned there. {@link topicLabels} is what
 * names a topic on screen, and it drops terms that occur in *every* topic
 * before choosing: a term present in all classes has, by definition, zero power
 * to distinguish one label from another. That is a statement about
 * discrimination rather than about English, so it needs no stopword dictionary
 * and no new threshold — and it makes `● redis · pool · timeout · the`
 * impossible. With a single topic there is nothing to contrast against, so the
 * rule does not apply and labelling falls back to raw frequency.
 */

/** One topic's pooled text, ready to be scored against its siblings. */
export type TopicDocument = { id: string; text: string };

export type KeywordConfig = {
  /** How many keywords a topic's label carries. UI-02's examples run three to four. */
  keywordsPerTopic: number;
};

/**
 * Splits text into comparable terms.
 *
 * Unicode-aware, so it does not quietly discard every non-Latin script. Single
 * characters are dropped as punctuation residue; everything longer is kept and
 * left for the IDF term to judge.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{Letter}\p{Number}]+/u)
    .filter((token) => token.length > 1);
}

/** One scored term. */
export type KeywordScore = { term: string; weight: number };

/**
 * Scores every term in every topic, strongest first.
 *
 * The scoring surface: nothing is filtered or capped here, so a term used
 * across the whole conversation keeps the weight it earned and stays available
 * to search and to `keywordDistinctiveness`. For what a topic is *called*, use
 * {@link topicLabels}.
 *
 * A topic with no usable text gets an empty list rather than being dropped — a
 * subject that was discussed still exists, even if it was discussed in numbers
 * and single letters.
 */
export function topicKeywords(documents: TopicDocument[]): Map<string, KeywordScore[]> {
  const perTopic = documents.map((document) => ({ id: document.id, terms: countTerms(document.text) }));

  // f(t): how often each term is used across every topic.
  const corpus = new Map<string, number>();
  let totalTokens = 0;
  for (const { terms } of perTopic) {
    for (const [term, count] of terms) {
      corpus.set(term, (corpus.get(term) ?? 0) + count);
      totalTokens += count;
    }
  }

  // A: the average topic length.
  const averageLength = perTopic.length ? totalTokens / perTopic.length : 0;

  const result = new Map<string, KeywordScore[]>();
  for (const { id, terms } of perTopic) {
    const length = [...terms.values()].reduce((sum, count) => sum + count, 0);
    const scored: KeywordScore[] = [];
    for (const [term, count] of terms) {
      const tf = count / length;
      const idf = Math.log(1 + averageLength / (corpus.get(term) ?? count));
      scored.push({ term, weight: tf * idf });
    }
    // Strongest first, ties broken alphabetically so a read is reproducible.
    scored.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
    result.set(id, scored);
  }
  return result;
}

/**
 * The keywords that name each topic on screen (UI-02).
 *
 * Drops terms occurring in every topic before capping, because such a term
 * cannot tell one label from another however heavily it is used. Skipped
 * entirely when there is only one topic, which has nothing to be distinguished
 * from.
 *
 * A degenerate case is left visible rather than papered over: two topics whose
 * vocabulary is identical have no distinguishing terms at all, so both labels
 * come back empty. That is the honest answer — if nothing separates them, no
 * word can be shown that does — and it is a signal that clustering split
 * something it should not have.
 */
export function topicLabels(documents: TopicDocument[], config: KeywordConfig): Map<string, string[]> {
  if (!Number.isInteger(config.keywordsPerTopic) || config.keywordsPerTopic < 1) {
    throw new Error(`A topic needs at least one keyword, not ${config.keywordsPerTopic}`);
  }

  const scored = topicKeywords(documents);
  const topicCount = documents.length;

  // df(t): how many topics use the term at all, as distinct from how often.
  const documentFrequency = new Map<string, number>();
  for (const terms of scored.values()) {
    for (const { term } of terms) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const labels = new Map<string, string[]>();
  for (const [id, terms] of scored) {
    const usable = topicCount > 1
      ? terms.filter(({ term }) => documentFrequency.get(term) !== topicCount)
      : terms;
    labels.set(id, usable.slice(0, config.keywordsPerTopic).map(({ term }) => term));
  }
  return labels;
}

function countTerms(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}
