/**
 * A synthetic meeting corpus with a realistic shape, for the 4A benchmark.
 *
 * Benchmarking 800 copies of one short string measures tokenizer caching and
 * nothing else: real encoder cost tracks token count, and a meeting's
 * utterances are heavily skewed short with a long tail. So windows here vary in
 * both length and vocabulary, across several subjects, with the recurrence a
 * real conversation has.
 *
 * Deterministic: the same seed yields the same corpus, so two runs compare.
 */

/** mulberry32 — small, fast, and reproducible across machines. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBJECTS = [
  'the redis connection pool saturated again under load and the workers queued behind it',
  'timeouts climbed once the pool hit its ceiling so requests waited on a free connection',
  'we should shard the cache or raise the connection limit before the next release',
  'the berlin flight leaves early so the hotel booking needs to cover the night before',
  'travel budget for the offsite covers flights and three nights of accommodation',
  'the frontend candidate interviewed well and the panel wants a second conversation',
  'hiring plan for the quarter is two engineers and one designer if headcount clears',
  'deploy is blocked on the migration finishing and the migration is blocked on review',
  'rollback took eleven minutes last time which is longer than the incident itself',
  'документация по кешированию устарела и её нужно переписать перед релизом',
  'die verbindung bricht ab wenn der pool voll ist und der dienst wartet',
];

const FILLER = [
  'yeah', 'right', 'okay', 'i think', 'sure', 'hmm', 'exactly', 'well',
  'i mean', 'sorry', 'go ahead', 'makes sense', 'agreed',
];

/**
 * Builds `count` window texts.
 *
 * Roughly a third are short backchannels, matching how much of a meeting is
 * one or two words; the rest are full utterances drawn from a rotating subject,
 * sometimes several sentences long. That gives the tokenizer a spread of
 * lengths rather than a single mode.
 */
export function buildBenchmarkWindows(count: number, seed = 20260912): string[] {
  const random = rng(seed);
  const windows: string[] = [];

  for (let i = 0; i < count; i += 1) {
    if (random() < 0.3) {
      const n = 1 + Math.floor(random() * 3);
      const parts = Array.from({ length: n }, () => FILLER[Math.floor(random() * FILLER.length)]);
      windows.push(parts.join(', '));
      continue;
    }
    // A window is 3–5 utterances (SEG-02), so it is several sentences of one
    // subject with the occasional interjection.
    const sentences = 3 + Math.floor(random() * 3);
    const base = Math.floor(random() * SUBJECTS.length);
    const parts: string[] = [];
    for (let s = 0; s < sentences; s += 1) {
      parts.push(random() < 0.2
        ? FILLER[Math.floor(random() * FILLER.length)]
        : SUBJECTS[(base + Math.floor(random() * 3)) % SUBJECTS.length]);
    }
    windows.push(parts.join('. '));
  }
  return windows;
}

/** Rough word-count summary, for reporting what was actually measured. */
export function describeCorpus(windows: string[]): string {
  const lengths = windows.map((w) => w.split(/\s+/).length).sort((a, b) => a - b);
  const at = (q: number) => lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * q))];
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  return `n=${lengths.length} words/window mean=${mean.toFixed(1)} p50=${at(0.5)} p90=${at(0.9)} max=${lengths[lengths.length - 1]}`;
}
