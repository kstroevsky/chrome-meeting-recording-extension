/**
 * ADR-0007 step 4A — dtype agreement sample. `@analysis-bench`
 *
 * Embeds a fixed multilingual sample and writes the vectors to
 * `output/analysis-agreement/<dtype>.json`. Run once per build, then compare
 * with `scripts/compare-embedding-dtypes.mjs`.
 *
 * Quantization is not a free size reduction: it moves the vectors, and every
 * boundary, cluster and score downstream is computed from cosines between them.
 * Package size and throughput are the easy half of the dtype decision; whether
 * the vectors still say the same thing is the half that decides whether 4B's
 * calibration transfers.
 *
 *   ANALYSIS_DTYPE=q8   npm run dev && EXTENSION_PATH=dist ANALYSIS_DTYPE=q8   npx playwright test agreement
 *   ANALYSIS_DTYPE=fp16 npm run dev && EXTENSION_PATH=dist ANALYSIS_DTYPE=fp16 npx playwright test agreement
 */

import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { closeHarness, launchExtensionHarness, type ExtensionHarness } from './helpers/extensionHarness';

test.setTimeout(300_000);

/** Meeting-shaped sentences across languages, with deliberate near-duplicates. */
const SAMPLE = [
  'the redis connection pool is saturated again',
  'the redis pool keeps running out of connections',
  'timeouts climbed once the pool hit its ceiling',
  'we should shard the cache before the next release',
  'raising the connection limit would buy us a week',
  'the berlin flight leaves early on thursday',
  'book the hotel for the night before the flight',
  'travel budget covers three nights of accommodation',
  'the frontend candidate interviewed well',
  'the panel wants a second conversation with the candidate',
  'hiring plan is two engineers and one designer',
  'deploy is blocked on the migration finishing',
  'rollback took eleven minutes last time',
  'the incident itself was shorter than the rollback',
  'документация по кешированию устарела',
  'нужно переписать документацию перед релизом',
  'пул соединений redis снова переполнен',
  'die verbindung bricht ab wenn der pool voll ist',
  'wir sollten das limit vor dem release erhöhen',
  'der flug nach berlin geht früh am donnerstag',
  'la documentación de caché está desactualizada',
  'el vuelo a berlín sale temprano el jueves',
  '接続プールがまた飽和しました',
  'キャッシュを分割する必要があります',
  'okay',
  'yeah exactly',
  'sorry go ahead',
];

test('dumps the multilingual agreement sample @analysis-bench', async ({}, testInfo) => {
  const dtype = process.env.ANALYSIS_DTYPE ?? 'q8';
  // WASM by default so the sample is comparable across dtypes on one backend;
  // FP16 is a WebGPU export and has to be sampled there.
  const device = process.env.ANALYSIS_DEVICE ?? 'wasm';
  let harness: ExtensionHarness | undefined;

  try {
    harness = await launchExtensionHarness(
      (segments) => path.join(testInfo.outputDir, segments),
      { extensionPath: process.env.EXTENSION_PATH ?? 'dist' },
    );
    const page = await harness.context.newPage();
    await page.goto(`chrome-extension://${harness.extensionId}/offscreen.html?runtime=tab`, {
      waitUntil: 'domcontentloaded',
    });

    const result = await page.evaluate(async ({ dtype, device, texts }) => {
      return await new Promise<{ device: string; vectors: number[][] }>((resolve, reject) => {
        const worker = new Worker(chrome.runtime.getURL('analysisWorker.js'));
        let opened: any;
        worker.onerror = (e) => reject(new Error((e as ErrorEvent).message || 'worker error'));
        worker.onmessage = (event: MessageEvent<any>) => {
          const m = event.data;
          if (m.type === 'ERROR') { worker.terminate(); reject(new Error(m.error)); return; }
          if (m.type === 'OPENED') { opened = m; worker.postMessage({ type: 'EMBED', seq: 2, texts }); return; }
          if (m.type === 'EMBEDDED') {
            const flat = Array.from(new Float32Array(m.vectors));
            const vectors: number[][] = [];
            for (let i = 0; i < m.count; i += 1) vectors.push(flat.slice(i * m.dimensions, (i + 1) * m.dimensions));
            worker.terminate();
            resolve({ device: opened.device, vectors });
          }
        };
        worker.postMessage({
          type: 'OPEN', seq: 1,
          modelBaseUrl: chrome.runtime.getURL('models/'),
          wasmBaseUrl: chrome.runtime.getURL('ort/'),
          modelId: 'Xenova/multilingual-e5-small',
          device, dtype,
        });
      });
    }, { dtype, device, texts: SAMPLE });

    const dir = path.resolve('output', 'analysis-agreement');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${dtype}.json`),
      JSON.stringify({ dtype, device: result.device, texts: SAMPLE, vectors: result.vectors }),
    );
    // eslint-disable-next-line no-console
    console.log(`    wrote ${dir}/${dtype}.json (${result.vectors.length} vectors on ${result.device})`);
  } finally {
    if (harness) await closeHarness(harness);
  }
});
