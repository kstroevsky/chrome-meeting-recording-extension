/**
 * @file shared/analysis/importance.ts
 *
 * Which moments in a topic are worth surfacing (IMP-01…06).
 *
 * All of it is vector arithmetic over embeddings already computed, so finding
 * the important moments is cheaper than finding the boundaries was, and it runs
 * on CPU (IMP-06).
 *
 * **The weights are contract; the terms are not.** IMP-03 fixes
 * 0.30/0.25/0.20/0.15/0.10 exactly, and those are constants below. It names the
 * five terms but defines none of them, so each definition here is
 * **provisional** and listed among §9's open contracts — the ADR-0007
 * validation settles them against real transcripts. They are written as small
 * exported functions precisely so a spike can replace one without touching the
 * blend.
 */

import { cosine } from './vector';
import { tokenize } from './keywords';
import type { Embedding } from './types';

/** Passage ranking weights (IMP-03). Exact contract; they sum to 1. */
export const IMPORTANCE_WEIGHTS = {
  similarityToTopic: 0.30,
  novelty: 0.25,
  keywordDistinctiveness: 0.20,
  recurrence: 0.15,
  discourseSignal: 0.10,
} as const;

/**
 * Phrases that mark a passage as consequential (IMP-04). Exact contract.
 *
 * The payload writes these with trailing ellipses — `"I think we should..."` —
 * denoting what the speaker goes on to say, so the phrase is what is matched.
 * Unlike SEG-06's cues, which open a turn, these carry weight wherever they
 * fall in a passage, so they are matched anywhere after a word boundary.
 *
 * English only, like SEG-06, while the encoder is multilingual: on a
 * non-English call this term contributes nothing and the blend degrades to
 * 0.30/0.25/0.20/0.15/0.00 rather than failing. IMP-07 replaces these with a
 * tiny classifier eventually, and is deferred.
 */
export const DISCOURSE_SIGNALS = [
  'i think we should',
  "let's do",
  'the reason is',
  'we discovered',
  'the problem is',
  'it turned out',
  "i'll",
  'we agreed',
] as const;

/** One candidate excerpt: a stretch of conversation with its embedding. */
export type Passage = {
  id: string;
  tStartMs: number;
  tEndMs: number;
  text: string;
  embedding: Embedding;
};

/** What a passage is being judged against. */
export type TopicContext = {
  centroid: Embedding;
  /** The topic's keywords, strongest first — see `keywords.ts`. */
  keywords: string[];
};

export type ImportanceConfig = {
  /**
   * MMR's trade-off between a passage's own importance and how much it repeats
   * one already chosen: 1 ignores redundancy, 0 ignores importance. Open
   * contract (§9).
   */
  mmrLambda: number;
};

export type ScoredPassage = Passage & {
  similarityToTopic: number;
  novelty: number;
  keywordDistinctiveness: number;
  recurrence: number;
  discourseSignal: number;
  importance: number;
};

/** How squarely a passage sits in its topic. Provisional (§9). */
export function similarityToTopic(passage: Passage, centroid: Embedding): number {
  // Text embeddings rarely point away from their own centroid; treating those
  // that do as simply "not similar" keeps 1 meaning identical.
  return Math.max(0, cosine(passage.embedding, centroid));
}

/**
 * How much a passage adds that earlier ones in the same topic did not.
 * Provisional (§9): one minus its closest match among the passages before it.
 */
export function novelty(passage: Passage, earlier: Passage[]): number {
  if (!earlier.length) return 1;
  const closest = Math.max(...earlier.map((other) => cosine(passage.embedding, other.embedding)));
  return Math.max(0, 1 - Math.max(0, closest));
}

/**
 * How much of a passage is the topic's own vocabulary. Provisional (§9): the
 * share of its words that are topic keywords.
 */
export function keywordDistinctiveness(passage: Passage, keywords: string[]): number {
  if (!keywords.length) return 0;
  const tokens = tokenize(passage.text);
  if (!tokens.length) return 0;
  const wanted = new Set(keywords);
  return tokens.filter((token) => wanted.has(token)).length / tokens.length;
}

/**
 * How much the topic keeps returning to this passage's ground. Provisional
 * (§9): its mean similarity to every other passage in the topic, which needs no
 * threshold — a point the conversation circles back to scores high, a one-off
 * aside scores low.
 */
export function recurrence(passage: Passage, siblings: Passage[]): number {
  const others = siblings.filter((other) => other.id !== passage.id);
  if (!others.length) return 0;
  const total = others.reduce((sum, other) => sum + Math.max(0, cosine(passage.embedding, other.embedding)), 0);
  return total / others.length;
}

/** Whether a passage carries one of IMP-04's phrases. */
export function discourseSignal(passage: Passage): number {
  const text = passage.text.toLowerCase().replace(/’/g, "'");
  return DISCOURSE_SIGNALS.some((phrase) => {
    let from = text.indexOf(phrase);
    while (from !== -1) {
      const before = from === 0 ? '' : text.charAt(from - 1);
      if (before === '' || !/[a-z0-9]/.test(before)) return true;
      from = text.indexOf(phrase, from + 1);
    }
    return false;
  }) ? 1 : 0;
}

/**
 * Scores every passage in a topic (IMP-02, IMP-03).
 *
 * ```text
 * importance = 0.30 × similarity_to_topic
 *            + 0.25 × novelty
 *            + 0.20 × keyword_distinctiveness
 *            + 0.15 × recurrence
 *            + 0.10 × discourse_signal
 * ```
 *
 * `novelty` reads the passages *before* each one, so the order given is the
 * order the conversation happened in.
 */
export function rankPassages(passages: Passage[], topic: TopicContext): ScoredPassage[] {
  return passages.map((passage, index) => {
    const signals = {
      similarityToTopic: similarityToTopic(passage, topic.centroid),
      novelty: novelty(passage, passages.slice(0, index)),
      keywordDistinctiveness: keywordDistinctiveness(passage, topic.keywords),
      recurrence: recurrence(passage, passages),
      discourseSignal: discourseSignal(passage),
    };
    return {
      ...passage,
      ...signals,
      importance: IMPORTANCE_WEIGHTS.similarityToTopic * signals.similarityToTopic
        + IMPORTANCE_WEIGHTS.novelty * signals.novelty
        + IMPORTANCE_WEIGHTS.keywordDistinctiveness * signals.keywordDistinctiveness
        + IMPORTANCE_WEIGHTS.recurrence * signals.recurrence
        + IMPORTANCE_WEIGHTS.discourseSignal * signals.discourseSignal,
    };
  });
}

/**
 * Maximal Marginal Relevance (IMP-05): picks the most important passages while
 * refusing to pick the same point twice.
 *
 * A topic's highest-scoring passages are often near-restatements of each other,
 * because whatever made one important tends to make its neighbours important
 * too. MMR discounts each candidate by how much it repeats what is already
 * chosen, so the excerpts a reader sees cover the topic rather than circling
 * one sentence.
 */
export function selectRepresentative(
  scored: ScoredPassage[],
  count: number,
  config: ImportanceConfig,
): ScoredPassage[] {
  const { mmrLambda } = config;
  if (!(mmrLambda >= 0 && mmrLambda <= 1)) {
    throw new Error(`An MMR lambda must be between 0 and 1, not ${mmrLambda}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`A topic needs at least one representative passage, not ${count}`);
  }

  const remaining = [...scored];
  const chosen: ScoredPassage[] = [];
  while (chosen.length < count && remaining.length) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const redundancy = chosen.length
        ? Math.max(...chosen.map((picked) => cosine(remaining[i].embedding, picked.embedding)))
        : 0;
      const score = mmrLambda * remaining[i].importance - (1 - mmrLambda) * redundancy;
      // Ties go to the earlier passage, so a read is reproducible.
      if (score > bestScore) { bestScore = score; bestIndex = i; }
    }
    chosen.push(remaining[bestIndex]);
    remaining.splice(bestIndex, 1);
  }
  return chosen;
}
