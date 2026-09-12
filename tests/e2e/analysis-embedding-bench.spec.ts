/**
 * ADR-0007 step 4A — realistic-scale embedding benchmark. `@analysis-bench`
 *
 * The runtime proof (`analysis-embedding.spec.ts`) showed two sentences work.
 * This measures the workload the pipeline will actually run: EMB-06's 300–800
 * contextual windows for a three-hour conversation, at EMB-07's production
 * batch size of 32, over text with a realistic length distribution.
 *
 * Model load happens once, then batches are timed individually so latency has a
 * distribution rather than an average.
 *
 *   npm run dev && EXTENSION_PATH=dist npx playwright test analysis-embedding-bench
 */

import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { closeHarness, launchExtensionHarness, type ExtensionHarness } from './helpers/extensionHarness';
import { buildBenchmarkWindows, describeCorpus } from './helpers/analysisCorpus';

test.setTimeout(900_000);

/** The dtype this build packaged; the benchmark measures what is there. */
const DTYPE = process.env.ANALYSIS_DTYPE ?? 'q8';
/** EMB-06's upper reference: a three-hour conversation's worth of windows. */
const WINDOWS = Number(process.env.BENCH_WINDOWS ?? 800);
/** EMB-07, exact contract. */
const BATCH = 32;

type BatchRun = {
  device: string;
  dtype: string;
  dimensions: number;
  loadMs: number;
  batchMs: number[];
  totalEmbedMs: number;
  heapBeforeBytes: number;
  heapAfterBytes: number;
};

/**
 * Resident memory of *this* browser's process tree, and nothing else.
 *
 * Matched on the throwaway `--user-data-dir` the harness created, because
 * matching on the process name sweeps in every other Chrome on the machine —
 * an earlier version of this did exactly that and reported 10 GB.
 *
 * The JS heap alone misses the WASM linear memory and every native allocation
 * ORT makes, which is most of what an embedding run costs, so RSS is the more
 * meaningful of the two. Neither captures **GPU allocation** — no API available
 * here exposes it — so both are a floor on real usage, not a total.
 */
function browserRssBytes(userDataDir: string): number {
  try {
    const out = execFileSync('ps', ['-Ao', 'rss,args'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return out.split('\n')
      .filter((line) => line.includes(userDataDir))
      .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0] || 0) * 1024, 0);
  } catch {
    return 0;
  }
}

const percentile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
};

test.describe('embedding throughput at realistic scale (ADR-0007 4A) @analysis-bench', () => {
  let harness: ExtensionHarness;

  test.beforeAll(async ({}, testInfo) => {
    harness = await launchExtensionHarness(
      (segments) => path.join(testInfo.outputDir, segments),
      { extensionPath: process.env.EXTENSION_PATH ?? 'dist' },
    );
  });
  test.afterAll(async () => { if (harness) await closeHarness(harness); });

  const backends: ('webgpu' | 'wasm')[] = process.env.ANALYSIS_DEVICE
    ? [process.env.ANALYSIS_DEVICE as 'webgpu' | 'wasm']
    : ['webgpu', 'wasm'];
  for (const requested of backends) {
    test(`${WINDOWS} windows at batch ${BATCH}, ${DTYPE} (requested: ${requested})`, async () => {
      const windows = buildBenchmarkWindows(WINDOWS);
      const rssBefore = browserRssBytes(harness.userDataDir);

      const page = await harness.context.newPage();
      await page.goto(`chrome-extension://${harness.extensionId}/offscreen.html?runtime=tab`, {
        waitUntil: 'domcontentloaded',
      });

      const run = await page.evaluate(async ({ device, texts, batch, dtype }) => {
        const heap = () => (performance as unknown as { memory?: { usedJSHeapSize: number } })
          .memory?.usedJSHeapSize ?? 0;

        return await new Promise<BatchRun>((resolve, reject) => {
          const worker = new Worker(chrome.runtime.getURL('analysisWorker.js'));
          const batches: string[][] = [];
          for (let i = 0; i < texts.length; i += batch) batches.push(texts.slice(i, i + batch));

          const batchMs: number[] = [];
          let opened: any;
          let next = 0;
          let startedAt = 0;
          let heapBeforeBytes = 0;

          const send = () => worker.postMessage({ type: 'EMBED', seq: 100 + next, texts: batches[next] });

          worker.onerror = (event) => reject(new Error((event as ErrorEvent).message || 'worker error'));
          worker.onmessage = (event: MessageEvent<any>) => {
            const message = event.data;
            if (message.type === 'ERROR') { worker.terminate(); reject(new Error(message.error)); return; }
            if (message.type === 'OPENED') {
              opened = message;
              heapBeforeBytes = heap();
              startedAt = performance.now();
              send();
              return;
            }
            if (message.type === 'EMBEDDED') {
              batchMs.push(message.embedMs);
              next += 1;
              if (next < batches.length) { send(); return; }
              const totalEmbedMs = Math.round(performance.now() - startedAt);
              const heapAfterBytes = heap();
              worker.terminate();
              resolve({
                device: opened.device,
                dtype: opened.dtype,
                dimensions: opened.dimensions,
                loadMs: opened.loadMs,
                batchMs,
                totalEmbedMs,
                heapBeforeBytes,
                heapAfterBytes,
              });
            }
          };

          worker.postMessage({
            type: 'OPEN',
            seq: 1,
            modelBaseUrl: chrome.runtime.getURL('models/'),
            wasmBaseUrl: chrome.runtime.getURL('ort/'),
            modelId: 'Xenova/multilingual-e5-small',
            device,
            dtype,
          });
        });
      }, { device: requested, texts: windows, batch: BATCH, dtype: DTYPE });

      const adapter = await page.evaluate(async () => {
        const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<any> } }).gpu;
        if (!gpu) return 'no navigator.gpu';
        const a = await gpu.requestAdapter().catch(() => null);
        if (!a) return 'no adapter';
        const info = a.info ?? (await a.requestAdapterInfo?.().catch(() => null)) ?? {};
        return [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ') || 'adapter, no info';
      }).catch(() => 'unavailable');

      await page.close().catch(() => {});
      const rssAfter = browserRssBytes(harness.userDataDir);

      expect(run.dimensions).toBe(384);
      expect(run.batchMs.length).toBe(Math.ceil(WINDOWS / BATCH));

      const mb = (bytes: number) => (bytes / 1048576).toFixed(1);
      // eslint-disable-next-line no-console
      console.log([
        '',
        `  ── requested ${requested} → ran on ${run.device} (${run.dtype}, ${run.dimensions}d)`,
        `     corpus            ${describeCorpus(windows)}`,
        `     model load        ${run.loadMs} ms`,
        `     total embedding   ${run.totalEmbedMs} ms for ${WINDOWS} windows in ${run.batchMs.length} batches`,
        `     throughput        ${(WINDOWS / (run.totalEmbedMs / 1000)).toFixed(1)} windows/sec`,
        `     batch latency     p50 ${percentile(run.batchMs, 0.5)} ms · p95 ${percentile(run.batchMs, 0.95)} ms · max ${Math.max(...run.batchMs)} ms`,
        `     JS heap           ${mb(run.heapBeforeBytes)} → ${mb(run.heapAfterBytes)} MB`,
        `     browser RSS       ${mb(rssBefore)} → ${mb(rssAfter)} MB (this browser only; excludes GPU allocation)`,
        `     webgpu adapter    ${adapter}`,
        '',
      ].join('\n'));
    });
  }
});
