/**
 * Compares two dtype runs of the agreement sample (ADR-0007 4A).
 *
 * Two questions, because they fail differently. **Cosine agreement** asks
 * whether each sentence lands in nearly the same place — a global drift shows
 * up here. **Nearest-neighbour overlap** asks whether the sentences still
 * consider the same sentences closest, which is what actually drives
 * clustering: vectors can drift a long way together and still cluster
 * identically, or drift slightly and reorder neighbours.
 *
 *   node scripts/compare-embedding-dtypes.mjs output/analysis-agreement/q8.json output/analysis-agreement/fp16.json
 */

import { readFileSync } from 'node:fs';

const cosine = (a, b) => {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / (Math.sqrt(aa) * Math.sqrt(bb)) : 0;
};

const neighbours = (vectors, i, k) => vectors
  .map((v, j) => ({ j, s: j === i ? -Infinity : cosine(vectors[i], v) }))
  .sort((x, y) => y.s - x.s)
  .slice(0, k)
  .map((e) => e.j);

const [, , leftPath, rightPath] = process.argv;
const left = JSON.parse(readFileSync(leftPath, 'utf8'));
const right = JSON.parse(readFileSync(rightPath, 'utf8'));
if (left.vectors.length !== right.vectors.length) throw new Error('samples differ in size');

const K = 5;
const agreements = left.vectors.map((v, i) => cosine(v, right.vectors[i]));
const overlaps = left.vectors.map((_, i) => {
  const a = new Set(neighbours(left.vectors, i, K));
  const b = neighbours(right.vectors, i, K);
  return b.filter((j) => a.has(j)).length / K;
});

const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { min: s[0], p10: s[Math.floor(s.length * 0.1)], mean, max: s[s.length - 1] };
};

const a = stat(agreements);
const o = stat(overlaps);
const worst = agreements
  .map((s, i) => ({ s, text: left.texts[i] }))
  .sort((x, y) => x.s - y.s)
  .slice(0, 3);

console.log(`\n${left.dtype} vs ${right.dtype}, n=${left.vectors.length}\n`);
console.log(`  per-sentence cosine   min ${a.min.toFixed(4)}  p10 ${a.p10.toFixed(4)}  mean ${a.mean.toFixed(4)}`);
console.log(`  top-${K} neighbour overlap  min ${o.min.toFixed(2)}  p10 ${o.p10.toFixed(2)}  mean ${o.mean.toFixed(2)}`);
console.log('\n  least-agreeing sentences:');
for (const w of worst) console.log(`    ${w.s.toFixed(4)}  ${w.text}`);
console.log();
