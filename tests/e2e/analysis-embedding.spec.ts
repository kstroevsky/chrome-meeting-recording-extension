/**
 * ADR-0007 step 4A — **production extension-page embedding runtime proof**.
 *
 * Proves that the packaged embedding stack runs inside a built MV3 extension:
 * Transformers.js and ONNX Runtime, loading a Q8 `multilingual-e5-small` from
 * `chrome-extension://` resources, under the real `extension_pages` CSP, in a
 * worker spawned from an extension page, with all outbound HTTP(S) blocked.
 *
 * **What this does not prove.** The page here is `offscreen.html` opened as an
 * ordinary extension tab, not a document created through `chrome.offscreen`.
 * That exercises the same origin, the same CSP and the same packaged resources,
 * so every runtime assumption above is genuinely tested — but the ownership and
 * lifecycle claim in HOST-01, that the worker is owned by the offscreen
 * document, is not. That is completed by an integration test once
 * `EmbeddingWorkerClient` is wired into the real offscreen host (step 6), and
 * is deliberately kept out of this spike.
 *
 * The network block is the part that makes the claim worth anything.
 * `allowRemoteModels = false` proves Transformers.js will not *fall back* to a
 * remote model; it does not prove no dependency reaches out. Aborting every
 * http(s) request and still getting vectors does.
 *
 *   npm run dev && EXTENSION_PATH=dist npx playwright test analysis-embedding
 */

import { expect, test } from '@playwright/test';
import path from 'node:path';
import { closeHarness, launchExtensionHarness, type ExtensionHarness } from './helpers/extensionHarness';

/** Loading ~130 MB of model and runtime is not a 15-second operation. */
test.setTimeout(300_000);

type EmbedOutcome = {
  ok: boolean;
  error?: string;
  device?: string;
  dtype?: string;
  dimensions?: number;
  loadMs?: number;
  embedMs?: number;
  vectors?: number[][];
};

const SENTENCES = [
  'the redis connection pool is saturated',
  'we should book the berlin flight',
];

/**
 * Drives the worker protocol from inside an extension page.
 *
 * The page resolves the extension URLs and hands them in, because the worker is
 * a plain computation environment that is told where its artifacts are rather
 * than one that reaches for `chrome.runtime.getURL()` itself.
 */
async function embedInExtensionPage(
  harness: ExtensionHarness,
  device: 'webgpu' | 'wasm',
): Promise<EmbedOutcome> {
  const page = await harness.context.newPage();
  await page.goto(`chrome-extension://${harness.extensionId}/offscreen.html?runtime=tab`, {
    waitUntil: 'domcontentloaded',
  });

  try {
    return await page.evaluate(async ({ device, texts }) => {
      return await new Promise<EmbedOutcome>((resolve) => {
        const worker = new Worker(chrome.runtime.getURL('analysisWorker.js'));
        const fail = (error: string) => { worker.terminate(); resolve({ ok: false, error }); };
        const timer = setTimeout(() => fail('timed out waiting for the worker'), 240_000);
        let opened: { device: string; dtype: string; dimensions: number; loadMs: number } | undefined;

        worker.onerror = (event) => {
          clearTimeout(timer);
          fail(`worker error: ${(event as ErrorEvent).message || 'unknown'}`);
        };
        worker.onmessage = (event: MessageEvent<any>) => {
          const message = event.data;
          if (message.type === 'ERROR') { clearTimeout(timer); fail(message.error); return; }
          if (message.type === 'OPENED') {
            opened = message;
            worker.postMessage({ type: 'EMBED', seq: 2, texts });
            return;
          }
          if (message.type === 'EMBEDDED') {
            clearTimeout(timer);
            const flat = Array.from(new Float32Array(message.vectors));
            const width = message.dimensions;
            const vectors: number[][] = [];
            for (let i = 0; i < message.count; i += 1) {
              vectors.push(flat.slice(i * width, (i + 1) * width));
            }
            worker.terminate();
            resolve({ ok: true, ...opened!, embedMs: message.embedMs, vectors });
          }
        };

        worker.postMessage({
          type: 'OPEN',
          seq: 1,
          modelBaseUrl: chrome.runtime.getURL('models/'),
          wasmBaseUrl: chrome.runtime.getURL('ort/'),
          modelId: 'Xenova/multilingual-e5-small',
          device,
          dtype: 'q8',
        });
      });
    }, { device, texts: SENTENCES });
  } finally {
    await page.close().catch(() => {});
  }
}

function l2(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
}

test.describe('packaged embedding runtime, extension page (ADR-0007 4A)', () => {
  let harness: ExtensionHarness;
  const attempted: string[] = [];

  test.beforeAll(async ({}, testInfo) => {
    harness = await launchExtensionHarness(
      (segments) => path.join(testInfo.outputDir, segments),
      { extensionPath: process.env.EXTENSION_PATH ?? 'dist' },
    );

    // Everything the analysis path might reach for, denied — and recorded, so a
    // failure names what it wanted rather than just timing out.
    await harness.context.route('http://**', (route) => {
      attempted.push(route.request().url());
      return route.abort();
    });
    await harness.context.route('https://**', (route) => {
      attempted.push(route.request().url());
      return route.abort();
    });
  });

  test.afterAll(async () => { if (harness) await closeHarness(harness); });

  for (const requested of ['webgpu', 'wasm'] as const) {
    test(`embeds two sentences with the network blocked (requested: ${requested})`, async () => {
      attempted.length = 0;
      const result = await embedInExtensionPage(harness, requested);

      expect(result.error ?? '').toBe('');
      expect(result.ok).toBe(true);

      // The worker reports which rung of the ladder actually ran, rather than
      // leaving it to be inferred from timing (RES-06, RES-08).
      expect(['webgpu', 'wasm']).toContain(result.device);
      if (requested === 'wasm') expect(result.device).toBe('wasm');
      expect(result.dtype).toBe('q8');

      expect(result.dimensions).toBe(384);
      expect(result.vectors).toHaveLength(SENTENCES.length);
      for (const vector of result.vectors!) {
        expect(vector).toHaveLength(384);
        expect(vector.every((v) => Number.isFinite(v))).toBe(true);
        // `normalize: true` is what lets every cosine in shared/analysis be a
        // dot product; if it silently stopped holding, every score would drift.
        expect(l2(vector)).toBeCloseTo(1, 3);
      }

      // Two different sentences must not collapse onto one point.
      const dot = result.vectors![0].reduce((sum, v, i) => sum + v * result.vectors![1][i], 0);
      expect(dot).toBeLessThan(0.999);

      // BLD-06: analysis performs no network fetch.
      expect(attempted, `unexpected network: ${attempted.join(', ')}`).toEqual([]);

      // eslint-disable-next-line no-console
      console.log(
        `    ${requested} → ran on ${result.device}, load ${result.loadMs}ms, embed ${result.embedMs}ms`,
      );
    });
  }

  test('produces the same vector for the same input', async () => {
    const first = await embedInExtensionPage(harness, 'wasm');
    const second = await embedInExtensionPage(harness, 'wasm');

    expect(first.ok && second.ok).toBe(true);
    const dot = first.vectors![0].reduce((sum, v, i) => sum + v * second.vectors![0][i], 0);
    expect(dot).toBeCloseTo(1, 4);
  });
});
