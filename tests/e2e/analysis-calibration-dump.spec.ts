/**
 * ADR-0007 step 4B — embeds the calibration corpus once. `@analysis-bench`
 *
 * Encoding is the expensive part of calibration and the part that must use the
 * *real* frozen encoder; the grid search over §9's values is cheap arithmetic
 * that runs thousands of times. So this embeds once, writes the vectors beside
 * the ground truth, and `scripts/calibrate-analysis.ts` searches offline.
 *
 *   npm run dev && EXTENSION_PATH=dist npx playwright test analysis-calibration-dump
 */

import { test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { closeHarness, launchExtensionHarness, type ExtensionHarness } from './helpers/extensionHarness';
import { buildCalibrationCases } from './helpers/calibrationCorpus';
import { buildContextWindows } from '../../src/shared/analysis/windows';

/**
 * Window shapes to embed.
 *
 * Window size and stride are themselves open contracts, and they change *what*
 * gets embedded rather than how it is scored — so unlike every other §9 value
 * they cannot be searched after the fact. Each candidate shape is embedded
 * here so the offline search can compare them.
 */
const SHAPES = [
  // Disjoint windows. SEG-02 compares "the previous 3–5 utterances" with "the
  // next 3–5" — two spans that share nothing. A stride shorter than the window
  // makes neighbours overlap, so a window straddling a boundary shares most of
  // its content with both sides and the boundary signal is smeared away. The
  // first calibration pass omitted these entirely and measured the smearing.
  { windowUtterances: 3, windowStride: 3 },
  { windowUtterances: 4, windowStride: 4 },
  { windowUtterances: 5, windowStride: 5 },
  // Overlapping, kept for comparison.
  { windowUtterances: 3, windowStride: 2 },
  { windowUtterances: 5, windowStride: 2 },
];

test.setTimeout(900_000);

test('embeds the calibration corpus @analysis-bench', async ({}, testInfo) => {
  const cases = buildCalibrationCases();
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

    // Every window of every case and every shape, in one batch stream, so the
    // model loads once for the whole corpus.
    const jobs: { caseName: string; shape: typeof SHAPES[number]; windows: ReturnType<typeof buildContextWindows> }[] = [];
    for (const c of cases) {
      for (const shape of SHAPES) jobs.push({ caseName: c.name, shape, windows: buildContextWindows(c.segments, shape) });
    }
    const texts = jobs.flatMap((j) => j.windows.map((w) => w.text));

    const dtype = process.env.ANALYSIS_DTYPE ?? 'q8';
    const vectors = await page.evaluate(async ({ texts, dtype }) => {
      return await new Promise<number[][]>((resolve, reject) => {
        const worker = new Worker(chrome.runtime.getURL('analysisWorker.js'));
        const BATCH = 32;
        const batches: string[][] = [];
        for (let i = 0; i < texts.length; i += BATCH) batches.push(texts.slice(i, i + BATCH));
        const all: number[][] = [];
        let next = 0;
        const send = () => worker.postMessage({ type: 'EMBED', seq: 100 + next, texts: batches[next] });

        worker.onerror = (e) => reject(new Error((e as ErrorEvent).message || 'worker error'));
        worker.onmessage = (event: MessageEvent<any>) => {
          const m = event.data;
          if (m.type === 'ERROR') { worker.terminate(); reject(new Error(m.error)); return; }
          if (m.type === 'OPENED') { send(); return; }
          if (m.type === 'EMBEDDED') {
            const flat = new Float32Array(m.vectors);
            for (let i = 0; i < m.count; i += 1) {
              all.push(Array.from(flat.slice(i * m.dimensions, (i + 1) * m.dimensions)));
            }
            next += 1;
            if (next < batches.length) { send(); return; }
            worker.terminate();
            resolve(all);
          }
        };
        worker.postMessage({
          type: 'OPEN', seq: 1,
          modelBaseUrl: chrome.runtime.getURL('models/'),
          wasmBaseUrl: chrome.runtime.getURL('ort/'),
          modelId: 'Xenova/multilingual-e5-small',
          device: 'webgpu', dtype,
        });
      });
    }, { texts, dtype });

    let cursor = 0;
    const payload = {
      dtype,
      cases: cases.map((c) => ({
        name: c.name,
        topicOfUtterance: c.topicOfUtterance,
        shapes: jobs.filter((j) => j.caseName === c.name).map((j) => {
          const embeddings = vectors.slice(cursor, cursor + j.windows.length);
          cursor += j.windows.length;
          return {
            shape: j.shape,
            windows: j.windows.map((w) => ({
              startIndex: w.startIndex, endIndex: w.endIndex,
              tStartMs: w.tStartMs, tEndMs: w.tEndMs,
              speakers: w.speakers, opensWithDiscourseCue: w.opensWithDiscourseCue,
              text: w.text,
            })),
            embeddings,
          };
        }),
      })),
    };

    const dir = path.resolve('output', 'analysis-calibration');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'corpus.json'), JSON.stringify(payload));
    // eslint-disable-next-line no-console
    console.log(`    embedded ${texts.length} windows across ${cases.length} cases × ${SHAPES.length} shapes`);
  } finally {
    if (harness) await closeHarness(harness);
  }
});
