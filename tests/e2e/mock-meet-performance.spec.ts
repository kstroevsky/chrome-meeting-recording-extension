import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import type { PerfSettings } from '../../src/shared/perf';
import type { MicMode } from '../../src/shared/recording';
import type { ResolutionPreset } from '../../src/shared/settings';
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openDebugDashboard,
  openMockMeetPage,
  probeHardwareMedia,
  saveRecordingSettings,
  setPerfSettings,
  startRecording,
  stopRecording,
  waitForCompletedDownloads,
  waitForPerfSnapshot,
} from './helpers/extensionHarness';
import {
  assertPerformanceSnapshot,
  runPerformanceCase,
  type MeetWorkload,
  type PerformanceCase,
} from './helpers/performanceRunner';
import { installDriveSimulator } from './helpers/driveSimulator';

const SHORT_MS = Number(process.env.PERF_CASE_SECONDS ?? 4) * 1_000;
const SMOKE_TAB_MS = Number(process.env.PERF_SMOKE_TAB_SECONDS ?? 8) * 1_000;
const SMOKE_MEDIA_MS = Number(process.env.PERF_SMOKE_MEDIA_SECONDS ?? 10) * 1_000;
const ENDURANCE_LOCAL_MS = Number(process.env.PERF_ENDURANCE_LOCAL_SECONDS ?? 600) * 1_000;
const ENDURANCE_DRIVE_MS = Number(process.env.PERF_ENDURANCE_DRIVE_SECONDS ?? 120) * 1_000;

const workloads = {
  minimal: { participants: 1, animationComplexity: 1 },
  normal: {
    participants: 4,
    animationComplexity: 12,
    captionIntervalMs: 1_000,
  },
  captionHeavy: {
    participants: 4,
    animationComplexity: 24,
    captionIntervalMs: 50,
    replacementIntervalMs: 500,
  },
  participantHeavy: {
    participants: 64,
    animationComplexity: 48,
    captionIntervalMs: 1_000,
  },
  combined: {
    participants: 64,
    animationComplexity: 100,
    captionIntervalMs: 50,
    replacementIntervalMs: 250,
  },
} satisfies Record<string, MeetWorkload>;

function baseCase(
  id: string,
  overrides: Partial<PerformanceCase> = {}
): PerformanceCase {
  return {
    id,
    durationMs: SHORT_MS,
    storageMode: 'local',
    micMode: 'off',
    recordSelfVideo: false,
    tabResolution: '640x360',
    tabFrameRate: 24,
    workload: workloads.normal,
    ...overrides,
  };
}

type PairwiseValue = {
  label: string;
  value: unknown;
};

function buildPairwiseCases(
  factors: Array<{ name: string; values: PairwiseValue[] }>
): Array<Record<string, PairwiseValue>> {
  const combinations: Array<Record<string, PairwiseValue>> = [];
  const visit = (index: number, current: Record<string, PairwiseValue>) => {
    if (index >= factors.length) {
      combinations.push({ ...current });
      return;
    }
    const factor = factors[index];
    for (const value of factor.values) {
      current[factor.name] = value;
      visit(index + 1, current);
    }
  };
  visit(0, {});

  const pairKeys = (candidate: Record<string, PairwiseValue>): string[] => {
    const keys = Object.keys(candidate);
    const pairs: string[] = [];
    for (let left = 0; left < keys.length; left += 1) {
      for (let right = left + 1; right < keys.length; right += 1) {
        pairs.push(
          `${keys[left]}=${candidate[keys[left]].label}|${keys[right]}=${candidate[keys[right]].label}`
        );
      }
    }
    return pairs;
  };
  const uncovered = new Set(combinations.flatMap(pairKeys));
  const selected: Array<Record<string, PairwiseValue>> = [];
  while (uncovered.size) {
    let best = combinations[0];
    let bestCoverage = -1;
    for (const candidate of combinations) {
      const coverage = pairKeys(candidate).filter((pair) => uncovered.has(pair)).length;
      if (coverage > bestCoverage) {
        best = candidate;
        bestCoverage = coverage;
      }
    }
    selected.push(best);
    for (const pair of pairKeys(best)) uncovered.delete(pair);
  }
  return selected;
}

const pairwiseInteractions = buildPairwiseCases([
  {
    name: 'resolution',
    values: (['640x360', '854x480', '1280x720', '1920x1080'] as ResolutionPreset[])
      .map((value) => ({ label: value, value })),
  },
  {
    name: 'fps',
    values: [15, 24, 30].map((value) => ({ label: String(value), value })),
  },
  {
    name: 'stream',
    values: [
      { label: 'off', value: { micMode: 'off' as MicMode, camera: false } },
      { label: 'mixed', value: { micMode: 'mixed' as MicMode, camera: false } },
      { label: 'separate', value: { micMode: 'separate' as MicMode, camera: false } },
      { label: 'mixed-camera', value: { micMode: 'mixed' as MicMode, camera: true } },
      { label: 'separate-camera', value: { micMode: 'separate' as MicMode, camera: true } },
    ],
  },
  {
    name: 'workload',
    values: Object.entries(workloads)
      .map(([label, value]) => ({ label, value })),
  },
  {
    name: 'flags',
    values: [
      { label: 'baseline', value: {} },
      { label: 'audio-auto', value: { audioPlaybackBridgeMode: 'auto' } },
      { label: 'timeslice', value: { extendedTimeslice: true } },
      { label: 'adaptive', value: { adaptiveSelfVideoProfile: true } },
      { label: 'dynamic-chunks', value: { dynamicDriveChunkSizing: true } },
      { label: 'parallel-two', value: { parallelUploadConcurrency: 2 } },
    ],
  },
]);

test.describe('mock Meet performance E2E', () => {
  test('@perf-smoke 640x360@24 tab-only local recording', async ({}, testInfo) => {
    await runPerformanceCase(testInfo, baseCase('smoke-tab-360p24', {
      durationMs: SMOKE_TAB_MS,
      workload: workloads.normal,
    }));
  });

  test('@perf-smoke 1920x1080@30 separate mic and camera local recording', async ({}, testInfo) => {
    const result = await runPerformanceCase(testInfo, baseCase('smoke-three-stream-1080p30', {
      durationMs: SMOKE_MEDIA_MS,
      micMode: 'separate',
      recordSelfVideo: true,
      tabResolution: '1920x1080',
      tabFrameRate: 30,
      selfVideoResolution: '1280x720',
      selfVideoFrameRate: 30,
      workload: workloads.normal,
    }));
    expect(result.artifacts).toHaveLength(3);
  });

  test('@perf-smoke three streams complete mocked Drive upload', async ({}, testInfo) => {
    const result = await runPerformanceCase(testInfo, baseCase('smoke-three-stream-drive', {
      storageMode: 'drive',
      micMode: 'separate',
      recordSelfVideo: true,
      driveProfile: 'fast',
      workload: workloads.normal,
    }));
    expect(result.drive?.sessionsCreated).toBe(3);
  });

  const resolutions: ResolutionPreset[] = [
    '640x360',
    '854x480',
    '1280x720',
    '1920x1080',
  ];
  for (const resolution of resolutions) {
    for (const fps of [15, 24, 30]) {
      test(`@perf-full profile ${resolution}@${fps}`, async ({}, testInfo) => {
        await runPerformanceCase(testInfo, baseCase(`profile-${resolution}-${fps}`, {
          tabResolution: resolution,
          tabFrameRate: fps,
          workload: workloads.minimal,
        }));
      });
    }
  }

  const streamCases: Array<{
    name: string;
    micMode: MicMode;
    camera: boolean;
  }> = [
    { name: 'mic-off', micMode: 'off', camera: false },
    { name: 'mixed', micMode: 'mixed', camera: false },
    { name: 'separate', micMode: 'separate', camera: false },
    { name: 'mixed-camera', micMode: 'mixed', camera: true },
    { name: 'separate-camera', micMode: 'separate', camera: true },
  ];
  for (const streamCase of streamCases) {
    test(`@perf-full streams ${streamCase.name}`, async ({}, testInfo) => {
      await runPerformanceCase(testInfo, baseCase(`streams-${streamCase.name}`, {
        micMode: streamCase.micMode,
        recordSelfVideo: streamCase.camera,
      }));
    });
  }

  for (const preset of resolutions) {
    test(`@perf-full camera requested versus delivered ${preset}`, async ({}, testInfo) => {
      const result = await runPerformanceCase(testInfo, baseCase(`camera-${preset}`, {
        recordSelfVideo: true,
        selfVideoResolution: preset,
        selfVideoFrameRate: 30,
      }));
      const requested = result.snapshot.summary.capture
        .lastRequestedProfileByStream['self-video'];
      const delivered = result.snapshot.summary.capture
        .lastDeliveredProfileByStream['self-video'];
      expect(requested?.width).toBe(Number(preset.split('x')[0]));
      expect(requested?.height).toBe(Number(preset.split('x')[1]));
      expect(delivered).toBeDefined();
    });
  }

  for (const [name, workload] of Object.entries(workloads)) {
    test(`@perf-full workload ${name}`, async ({}, testInfo) => {
      const result = await runPerformanceCase(testInfo, baseCase(`workload-${name}`, {
        workload,
      }));
      expect(result.workloadStats.participants).toBe(workload.participants);
      if ((workload as MeetWorkload).captionIntervalMs) {
        expect(result.snapshot.summary.captions.mutationCount).toBeGreaterThan(0);
        expect(result.snapshot.summary.captions.mutationThroughputPerSecond)
          .toBeGreaterThan(0);
      }
    });
  }

  const flagCases: Array<{
    name: string;
    settings: Partial<PerfSettings>;
    micMode?: MicMode;
    camera?: boolean;
  }> = [
    { name: 'audio-bridge-always', settings: { audioPlaybackBridgeMode: 'always' }, micMode: 'mixed' },
    { name: 'audio-bridge-auto', settings: { audioPlaybackBridgeMode: 'auto' }, micMode: 'mixed' },
    { name: 'extended-timeslice', settings: { extendedTimeslice: true }, micMode: 'separate', camera: true },
    { name: 'adaptive-camera-bitrate', settings: { adaptiveSelfVideoProfile: true }, camera: true },
    { name: 'dynamic-drive-chunks', settings: { dynamicDriveChunkSizing: true } },
    { name: 'parallel-upload-two', settings: { parallelUploadConcurrency: 2 }, micMode: 'separate', camera: true },
  ];
  for (const flagCase of flagCases) {
    test(`@perf-full flag A/B ${flagCase.name}`, async ({}, testInfo) => {
      const drive = flagCase.name.includes('drive') || flagCase.name.includes('upload');
      const dynamicChunks = flagCase.settings.dynamicDriveChunkSizing === true;
      const result = await runPerformanceCase(testInfo, baseCase(`flag-${flagCase.name}`, {
        storageMode: drive ? 'drive' : 'local',
        driveProfile: drive ? 'throttled' : undefined,
        driveThrottleMs: drive ? 300 : undefined,
        durationMs: dynamicChunks ? 30_000 : SHORT_MS,
        tabResolution: dynamicChunks ? '1920x1080' : '640x360',
        tabFrameRate: dynamicChunks ? 30 : 24,
        micMode: flagCase.micMode ?? 'off',
        recordSelfVideo: flagCase.camera ?? false,
        perfSettings: flagCase.settings,
      }));
      for (const [key, value] of Object.entries(flagCase.settings)) {
        expect(result.snapshot.settings[key as keyof PerfSettings]).toBe(value);
      }
      if (flagCase.settings.parallelUploadConcurrency === 2) {
        expect(result.drive?.maxConcurrentUploads).toBeGreaterThanOrEqual(2);
      }
      if (flagCase.settings.audioPlaybackBridgeMode) {
        expect(result.snapshot.summary.recorder.lastAudioBridgeMode)
          .toBe(flagCase.settings.audioPlaybackBridgeMode);
      }
      if (flagCase.settings.extendedTimeslice) {
        expect(result.snapshot.summary.recorder.lastTimesliceMs).toBe(2_000);
      }
      if (dynamicChunks) {
        expect(result.drive?.dataPuts).toBeGreaterThan(1);
      }
    });
  }

  pairwiseInteractions.forEach((interaction, index) => {
    const stream = interaction.stream.value as { micMode: MicMode; camera: boolean };
    const flags = interaction.flags.value as Partial<PerfSettings>;
    const usesDrive = flags.dynamicDriveChunkSizing === true
      || flags.parallelUploadConcurrency === 2;
    test(`@perf-full pairwise ${index + 1} ${Object.values(interaction).map((entry) => entry.label).join(' ')}`, async ({}, testInfo) => {
      await runPerformanceCase(testInfo, baseCase(`pairwise-${index + 1}`, {
        durationMs: Math.min(SHORT_MS, 2_000),
        storageMode: usesDrive ? 'drive' : 'local',
        driveProfile: usesDrive ? 'fast' : undefined,
        tabResolution: interaction.resolution.value as ResolutionPreset,
        tabFrameRate: interaction.fps.value as number,
        micMode: stream.micMode,
        recordSelfVideo: stream.camera,
        workload: interaction.workload.value as MeetWorkload,
        perfSettings: flags,
        analyzeArtifacts: false,
      }));
    });
  });

  for (const profile of [
    'fast',
    'throttled',
    'retry',
    'partial-commit',
    'token-refresh',
    'permanent-failure',
  ] as const) {
    test(`@perf-full Drive ${profile}`, async ({}, testInfo) => {
      const result = await runPerformanceCase(testInfo, baseCase(`drive-${profile}`, {
        storageMode: 'drive',
        driveProfile: profile,
        driveThrottleMs: profile === 'throttled' ? 300 : undefined,
      }));
      if (profile === 'retry' || profile === 'partial-commit') {
        expect(result.drive?.retryResponses).toBeGreaterThan(0);
        expect(result.drive?.statusProbes).toBeGreaterThan(0);
      }
      if (profile === 'token-refresh') {
        expect(result.drive?.authFailures).toBeGreaterThan(0);
      }
    });
  }

  test('@perf-full reliability cold/warm starts and five-run repeatability', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    const measured: number[] = [];
    let coldStartLatencyMs: number | null = null;
    try {
      await setPerfSettings(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: 'opfs',
        micMode: 'off',
        tabResolution: '640x360',
        tabFrameRate: 24,
        chunkDefaultTimesliceMs: 1_000,
      });
      await openDebugDashboard(harness);
      await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);

      for (let run = 0; run < 6; run += 1) {
        await startRecording(harness.controlPage, tabId, {
          storageMode: 'local',
          micMode: 'off',
          recordSelfVideo: false,
        });
        await harness.controlPage.waitForTimeout(Math.min(SHORT_MS, 2_000));
        await stopRecording(harness.controlPage);
        await waitForCompletedDownloads(
          harness.controlPage,
          harness.downloadsDir,
          run + 1,
          60_000
        );
        const snapshot = await waitForPerfSnapshot(
          harness.controlPage,
          (candidate) => candidate.summary.lifecycle.stopCompletedCount >= run + 1,
          30_000
        );
        const latency = snapshot.summary.recorder.lastStartLatencyMsByStream.tab;
        expect(latency).toBeGreaterThanOrEqual(0);
        if (run === 0) coldStartLatencyMs = latency ?? null;
        else if (latency != null) measured.push(latency);
      }

      const finalSnapshot = await waitForPerfSnapshot(
        harness.controlPage,
        (candidate) => candidate.summary.lifecycle.stopCompletedCount >= 6,
        30_000
      );
      expect(finalSnapshot.summary.lifecycle.startCompletedCount).toBe(6);
      expect(finalSnapshot.summary.lifecycle.activeTracks).toBe(0);
      expect(finalSnapshot.summary.lifecycle.failureCount).toBe(0);
    } finally {
      await closeHarness(harness);
    }

    const sorted = [...measured].sort((a, b) => a - b);
    const report = {
      discardedWarmup: true,
      coldStartLatencyMs,
      warmStartLatencyMs: measured,
      median: sorted[Math.floor(sorted.length / 2)] ?? null,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    };
    const reportPath = testInfo.outputPath('repeatability.json');
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    await testInfo.attach('repeatability', {
      path: reportPath,
      contentType: 'application/json',
    });
    expect(measured).toHaveLength(5);
  });

  test('@perf-full reliability 20 start/stop cycles', async ({}, testInfo) => {
    test.setTimeout(12 * 60_000);
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      await setPerfSettings(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: 'opfs',
        micMode: 'off',
        tabResolution: '640x360',
        tabFrameRate: 15,
        chunkDefaultTimesliceMs: 500,
      });
      await openDebugDashboard(harness);
      await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);
      for (let cycle = 0; cycle < 20; cycle += 1) {
        await startRecording(harness.controlPage, tabId, {
          storageMode: 'local',
          micMode: 'off',
          recordSelfVideo: false,
        });
        await harness.controlPage.waitForTimeout(500);
        await stopRecording(harness.controlPage);
        await waitForCompletedDownloads(
          harness.controlPage,
          harness.downloadsDir,
          cycle + 1,
          60_000
        );
      }
      const snapshot = await waitForPerfSnapshot(
        harness.controlPage,
        (candidate) => candidate.summary.lifecycle.stopCompletedCount >= 20,
        30_000
      );
      expect(snapshot.summary.lifecycle.startCompletedCount).toBe(20);
      expect(snapshot.summary.lifecycle.stopCompletedCount).toBe(20);
      expect(snapshot.summary.lifecycle.activeTracks).toBe(0);
      expect(snapshot.summary.lifecycle.failureCount).toBe(0);
    } finally {
      await closeHarness(harness);
    }
  });

  test('@perf-full reliability Drive failure recovers on a later local run', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const drive = await installDriveSimulator(harness.context, 'permanent-failure');
      await setPerfSettings(harness.controlPage);
      await openDebugDashboard(harness);
      await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);

      await saveRecordingSettings(harness.controlPage, {
        recordingMode: 'drive',
        micMode: 'off',
        tabResolution: '640x360',
        tabFrameRate: 24,
      });
      await startRecording(harness.controlPage, tabId, {
        storageMode: 'drive',
        micMode: 'off',
        recordSelfVideo: false,
      });
      await harness.controlPage.waitForTimeout(Math.min(SHORT_MS, 2_000));
      await stopRecording(harness.controlPage);
      await waitForCompletedDownloads(
        harness.controlPage,
        harness.downloadsDir,
        1,
        60_000
      );

      await saveRecordingSettings(harness.controlPage, {
        recordingMode: 'opfs',
        micMode: 'off',
        tabResolution: '640x360',
        tabFrameRate: 24,
      });
      await startRecording(harness.controlPage, tabId, {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      });
      await harness.controlPage.waitForTimeout(Math.min(SHORT_MS, 2_000));
      await stopRecording(harness.controlPage);
      await waitForCompletedDownloads(
        harness.controlPage,
        harness.downloadsDir,
        2,
        60_000
      );

      const snapshot = await waitForPerfSnapshot(
        harness.controlPage,
        (candidate) => candidate.summary.lifecycle.stopCompletedCount >= 2,
        30_000
      );
      expect(drive.permanentFailures).toBeGreaterThan(0);
      expect(snapshot.summary.upload.fallbackCount).toBe(1);
      expect(snapshot.summary.lifecycle.startCompletedCount).toBe(2);
      expect(snapshot.summary.lifecycle.stopCompletedCount).toBe(2);
      expect(snapshot.summary.lifecycle.failureCount).toBe(0);
      expect(snapshot.summary.lifecycle.activeTracks).toBe(0);

      const reportPath = testInfo.outputPath('failure-recovery-snapshot.json');
      await fs.writeFile(reportPath, JSON.stringify({ drive, snapshot }, null, 2));
      await testInfo.attach('failure-recovery-snapshot', {
        path: reportPath,
        contentType: 'application/json',
      });
    } finally {
      await closeHarness(harness);
    }
  });

  test('@perf-endurance ten-minute three-stream local recording', async ({}, testInfo) => {
    test.setTimeout(15 * 60_000);
    await runPerformanceCase(testInfo, baseCase('endurance-local-three-stream', {
      durationMs: ENDURANCE_LOCAL_MS,
      micMode: 'separate',
      recordSelfVideo: true,
      tabResolution: '1920x1080',
      tabFrameRate: 30,
      selfVideoResolution: '1280x720',
      workload: workloads.combined,
    }));
  });

  test('@perf-endurance two-minute throttled Drive upload', async ({}, testInfo) => {
    test.setTimeout(8 * 60_000);
    await runPerformanceCase(testInfo, baseCase('endurance-throttled-drive', {
      durationMs: ENDURANCE_DRIVE_MS,
      storageMode: 'drive',
      micMode: 'separate',
      recordSelfVideo: true,
      driveProfile: 'throttled',
      driveThrottleMs: 2_000,
      perfSettings: {
        dynamicDriveChunkSizing: true,
        parallelUploadConcurrency: 2,
      },
      workload: workloads.combined,
    }));
  });

  test('@perf-hardware physical microphone and camera', async ({}, testInfo) => {
    test.skip(process.env.PW_REAL_MEDIA !== '1', 'Set PW_REAL_MEDIA=1 on a labelled hardware runner');
    test.setTimeout(5 * 60_000);
    const probeHarness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), {
      deviceMode: 'hardware',
      headless: false,
    });
    let probe: Awaited<ReturnType<typeof probeHardwareMedia>>;
    try {
      probe = await probeHardwareMedia(probeHarness);
      const hardwarePath = testInfo.outputPath('hardware-probe.json');
      await fs.writeFile(hardwarePath, JSON.stringify(probe, null, 2));
      await testInfo.attach('hardware-probe', {
        path: hardwarePath,
        contentType: 'application/json',
      });
    } finally {
      await closeHarness(probeHarness);
    }
    test.skip(!probe.ok, `Hardware unavailable or permission denied: ${probe.error ?? 'missing tracks'}`);

    const result = await runPerformanceCase(testInfo, baseCase('hardware-media', {
      durationMs: Number(process.env.PERF_HARDWARE_SECONDS ?? 15) * 1_000,
      micMode: 'separate',
      recordSelfVideo: true,
      tabResolution: '1280x720',
      tabFrameRate: 30,
      selfVideoResolution: '1280x720',
      deviceMode: 'hardware',
      headless: false,
      hardwareMarkerDelayMs: process.env.PERF_HARDWARE_MARKER === '1'
        ? 5_000
        : undefined,
      workload: workloads.normal,
    }));
    for (const artifact of result.artifacts) {
      expect(artifact.durationSeconds).toBeGreaterThan(5);
      expect(artifact.silenceDurationSeconds).toBeLessThan(
        Math.max(5, (artifact.durationSeconds ?? 0) * 0.9)
      );
    }
  });
});
