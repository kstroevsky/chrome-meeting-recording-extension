import { expect, type TestInfo } from '@playwright/test';
import fs from 'node:fs/promises';
import type { PerfDebugSnapshot, PerfSettings } from '../../../src/shared/perf';
import type { MicMode, RecordingStream } from '../../../src/shared/recording';
import type { ResolutionPreset } from '../../../src/shared/settings';
import {
  closeHarness,
  collectBrowserMetrics,
  expectedStreams,
  findMockMeetTabId,
  getDownloads,
  launchExtensionHarness,
  openDebugDashboard,
  openMockMeetPage,
  saveRecordingSettings,
  setPerfSettings,
  startRecording,
  stopRecording,
  waitForCompletedDownloads,
  waitForPerfSnapshot,
  type BrowserMetricSnapshot,
  type DeviceMode,
  type ExtensionHarness,
} from './extensionHarness';
import {
  installDriveSimulator,
  type DriveSimulatorProfile,
  type DriveSimulatorStats,
} from './driveSimulator';
import {
  analyzeMediaArtifact,
  assertMediaToolsAvailable,
  type MediaArtifactAnalysis,
} from './mediaAnalysis';

export type MeetWorkload = {
  participants: number;
  animationComplexity: number;
  captionIntervalMs?: number;
  replacementIntervalMs?: number;
};

export type PerformanceCase = {
  id: string;
  durationMs: number;
  storageMode: 'local' | 'drive';
  micMode: MicMode;
  recordSelfVideo: boolean;
  tabResolution: ResolutionPreset;
  tabFrameRate: number;
  selfVideoResolution?: ResolutionPreset;
  selfVideoFrameRate?: number;
  workload: MeetWorkload;
  perfSettings?: Partial<PerfSettings>;
  driveProfile?: DriveSimulatorProfile;
  driveThrottleMs?: number;
  deviceMode?: DeviceMode;
  headless?: boolean;
  analyzeArtifacts?: boolean;
  hardwareMarkerDelayMs?: number;
};

export type PerformanceCaseResult = {
  case: PerformanceCase;
  snapshot: PerfDebugSnapshot;
  browserBefore: BrowserMetricSnapshot;
  browserAfter: BrowserMetricSnapshot;
  browserCpuDeltaSecondsByType: Record<string, number> | null;
  artifacts: MediaArtifactAnalysis[];
  drive: DriveSimulatorStats | null;
  workloadStats: {
    frame: number;
    captionSequence: number;
    participants: number;
    animationComplexity: number;
  };
};

function dimensions(preset: ResolutionPreset): { width: number; height: number } {
  const [width, height] = preset.split('x').map(Number);
  return { width, height };
}

function cpuDelta(
  before: BrowserMetricSnapshot,
  after: BrowserMetricSnapshot
): Record<string, number> | null {
  if (!before.processCpuTimeSecondsByType || !after.processCpuTimeSecondsByType) return null;
  const keys = new Set([
    ...Object.keys(before.processCpuTimeSecondsByType),
    ...Object.keys(after.processCpuTimeSecondsByType),
  ]);
  return Object.fromEntries([...keys].map((key) => [
    key,
    Math.max(
      0,
      (after.processCpuTimeSecondsByType?.[key] ?? 0)
        - (before.processCpuTimeSecondsByType?.[key] ?? 0)
    ),
  ]));
}

function expectedCaptureStreams(testCase: PerformanceCase): RecordingStream[] {
  const streams: RecordingStream[] = ['tab'];
  if (testCase.micMode !== 'off') streams.push('mic');
  if (testCase.recordSelfVideo) streams.push('self-video');
  return streams;
}

function collectNegativeMetrics(snapshot: PerfDebugSnapshot): string[] {
  const negatives: string[] = [];
  for (const entry of snapshot.entries) {
    for (const [key, value] of Object.entries(entry.fields)) {
      if (
        typeof value === 'number'
        && Number.isFinite(value)
        && value < 0
        && /(duration|latency|bytes|throughput|count|pending|tracks)/i.test(key)
      ) {
        negatives.push(`${entry.scope}:${entry.event}.${key}=${value}`);
      }
    }
  }
  return negatives;
}

export function assertPerformanceSnapshot(
  snapshot: PerfDebugSnapshot,
  testCase: PerformanceCase
): void {
  expect(snapshot.enabled).toBe(true);
  expect(snapshot.droppedEvents).toBe(0);
  expect(snapshot.entries.length).toBeGreaterThan(0);
  expect(collectNegativeMetrics(snapshot)).toEqual([]);
  expect(snapshot.summary.lifecycle.startCompletedCount).toBeGreaterThanOrEqual(1);
  expect(snapshot.summary.lifecycle.stopCompletedCount).toBeGreaterThanOrEqual(1);
  expect(snapshot.summary.lifecycle.failureCount).toBe(0);
  expect(snapshot.summary.lifecycle.activeTracks).toBe(0);

  for (const stream of expectedStreams(testCase.micMode, testCase.recordSelfVideo)) {
    expect(snapshot.summary.recorder.startCountByStream[stream]).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.recorder.chunkCountByStream[stream]).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.recorder.chunkBytesByStream[stream]).toBeGreaterThan(0);
    expect(snapshot.summary.recorder.lastStartLatencyMsByStream[stream]).toBeGreaterThanOrEqual(0);
    expect(snapshot.summary.recorder.lastArtifactBytesByStream[stream]).toBeGreaterThan(0);
  }

  for (const stream of expectedCaptureStreams(testCase)) {
    expect(snapshot.summary.capture.successCountByStream[stream]).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.capture.lastDurationMsByStream[stream]).toBeGreaterThanOrEqual(0);
  }

  expect(snapshot.summary.storage.openFailureCount).toBe(0);
  expect(snapshot.summary.storage.openCount).toBeGreaterThanOrEqual(
    expectedStreams(testCase.micMode, testCase.recordSelfVideo).length
  );
  expect(snapshot.summary.storage.currentPendingWrites).toBe(0);
  expect(snapshot.summary.finalization.count).toBeGreaterThanOrEqual(1);
  expect(snapshot.summary.captions.maxObserverCount).toBeGreaterThanOrEqual(1);
}

function assertArtifact(
  artifact: MediaArtifactAnalysis,
  testCase: PerformanceCase,
  snapshot: PerfDebugSnapshot
): void {
  expect(artifact.sizeBytes).toBeGreaterThan(0);
  expect(artifact.durationSeconds).toBeGreaterThan(testCase.durationMs / 1000 * 0.45);
  expect(artifact.formatName).toContain('webm');
  expect(artifact.streams.length).toBeGreaterThan(0);

  const video = artifact.streams.find((stream) => stream.codecType === 'video');
  const audio = artifact.streams.find((stream) => stream.codecType === 'audio');
  expect(artifact.recordingStream).not.toBeNull();
  if (audio) {
    expect(audio.codecName).toMatch(/opus|vorbis/);
    expect(artifact.audioRmsDb).not.toBeNull();
    expect(artifact.audioPeakDb).not.toBeNull();
    expect(artifact.audioPeakDb).toBeLessThanOrEqual(1);
    expect(artifact.silenceDurationSeconds).toBeLessThan(
      Math.max(1.5, (artifact.durationSeconds ?? 0) * 0.98)
    );
  }
  if (artifact.recordingStream === 'mic') {
    expect(video).toBeUndefined();
    expect(audio).toBeDefined();
    return;
  }

  expect(video).toBeDefined();
  expect(video?.codecName).toMatch(/vp8|vp9|av1/);
  expect(video?.frameCount).toBeGreaterThan(0);
  if (video?.averageFps != null) expect(video.averageFps).toBeGreaterThan(0);
  expect(artifact.blackDurationSeconds).toBeLessThan(
    Math.max(1, (artifact.durationSeconds ?? 1) * 0.5)
  );
  expect(artifact.freezeDurationSeconds).toBeLessThan(
    Math.max(2, (artifact.durationSeconds ?? 1) * 0.75)
  );

  const stream = artifact.recordingStream;
  if (stream === 'tab' || stream === 'self-video') {
    const requested = dimensions(
      stream === 'tab'
        ? testCase.tabResolution
        : testCase.selfVideoResolution ?? '640x360'
    );
    const delivered = snapshot.summary.capture.lastDeliveredProfileByStream[stream];
    const expectedWidth = delivered?.width ?? requested.width;
    const expectedHeight = delivered?.height ?? requested.height;
    if (stream === 'tab') {
      expect(video?.width).toBe(expectedWidth);
      expect(video?.height).toBe(expectedHeight);
    } else {
      expect(video?.width).toBeGreaterThan(0);
      expect(video?.height).toBeGreaterThan(0);
      const expectedAspectRatio = expectedWidth / expectedHeight;
      const encodedAspectRatio = (video?.width ?? 0) / (video?.height ?? 1);
      expect(Math.abs(encodedAspectRatio - expectedAspectRatio)).toBeLessThan(0.03);
    }
  }

  if (stream === 'tab') {
    expect(audio).toBeDefined();
    if (artifact.avDurationDriftMs != null) {
      expect(artifact.avDurationDriftMs).toBeLessThan(1_500);
    }
    if (artifact.markerDriftMs != null) {
      expect(artifact.markerDriftMs).toBeLessThan(500);
    }
  } else if (stream === 'self-video') {
    expect(audio).toBeUndefined();
  }
}

function inferRecordingStream(artifact: MediaArtifactAnalysis): RecordingStream {
  const hasVideo = artifact.streams.some((stream) => stream.codecType === 'video');
  const hasAudio = artifact.streams.some((stream) => stream.codecType === 'audio');
  if (hasVideo && hasAudio) return 'tab';
  if (hasAudio) return 'mic';
  if (hasVideo) return 'self-video';
  throw new Error(`Could not infer recording stream for ${artifact.path}`);
}

async function persistResult(
  testInfo: TestInfo,
  result: PerformanceCaseResult
): Promise<void> {
  const safeId = result.case.id.replace(/[^a-z0-9_-]+/gi, '-');
  const reportPath = testInfo.outputPath(`${safeId}-performance-report.json`);
  const diagnosticsPath = testInfo.outputPath(`${safeId}-perf-debug-snapshot.json`);
  await Promise.all([
    fs.writeFile(reportPath, JSON.stringify(result, null, 2)),
    fs.writeFile(diagnosticsPath, JSON.stringify(result.snapshot, null, 2)),
  ]);
  await Promise.all([
    testInfo.attach(`${safeId}-performance-report`, {
      path: reportPath,
      contentType: 'application/json',
    }),
    testInfo.attach(`${safeId}-perf-debug-snapshot`, {
      path: diagnosticsPath,
      contentType: 'application/json',
    }),
  ]);
}

export async function runPerformanceCase(
  testInfo: TestInfo,
  testCase: PerformanceCase
): Promise<PerformanceCaseResult> {
  let harness: ExtensionHarness | null = null;
  try {
    harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), {
      deviceMode: testCase.deviceMode,
      headless: testCase.headless,
      viewport: { width: 1280, height: 900 },
    });
    const drive = testCase.storageMode === 'drive'
      ? await installDriveSimulator(
        harness.context,
        testCase.driveProfile ?? 'fast',
        {
          throttleMs: testCase.driveThrottleMs,
        }
      )
      : null;

    await setPerfSettings(harness.controlPage, testCase.perfSettings);
    await saveRecordingSettings(harness.controlPage, {
      recordingMode: testCase.storageMode === 'local' ? 'opfs' : 'drive',
      micMode: testCase.micMode,
      recordSelfVideo: testCase.recordSelfVideo,
      tabResolution: testCase.tabResolution,
      tabFrameRate: testCase.tabFrameRate,
      selfVideoResolution: testCase.selfVideoResolution ?? '640x360',
      selfVideoFrameRate: testCase.selfVideoFrameRate ?? 30,
      chunkDefaultTimesliceMs: 1_000,
      chunkExtendedTimesliceMs: 2_000,
    });

    const debugPage = await openDebugDashboard(harness);
    const meetPage = await openMockMeetPage(harness.context);
    const meetTabId = await findMockMeetTabId(harness.controlPage);
    await meetPage.evaluate((workload) => {
      (window as any).mockMeet.startWorkload(workload);
    }, testCase.workload);
    if (testCase.hardwareMarkerDelayMs != null) {
      await meetPage.evaluate((delayMs) => {
        (window as any).mockMeet.scheduleHardwareMarker(delayMs);
      }, testCase.hardwareMarkerDelayMs);
    }

    const browserBefore = await collectBrowserMetrics(harness, meetPage);
    await startRecording(harness.controlPage, meetTabId, {
      storageMode: testCase.storageMode,
      micMode: testCase.micMode,
      recordSelfVideo: testCase.recordSelfVideo,
    });
    await waitForPerfSnapshot(
      harness.controlPage,
      (snapshot) => expectedStreams(testCase.micMode, testCase.recordSelfVideo)
        .every((stream) => (snapshot.summary.recorder.startCountByStream[stream] ?? 0) > 0),
      30_000
    );

    await meetPage.waitForTimeout(testCase.durationMs);
    const workloadStats = await meetPage.evaluate(() => (window as any).mockMeet.getStats());
    await stopRecording(harness.controlPage);

    const artifactCount = expectedStreams(
      testCase.micMode,
      testCase.recordSelfVideo
    ).length;
    const snapshot = await waitForPerfSnapshot(
      harness.controlPage,
      (candidate) =>
        candidate.summary.lifecycle.stopCompletedCount > 0
        && candidate.summary.finalization.count > 0
        && (
          testCase.storageMode === 'local'
          || candidate.summary.upload.uploadedCount
            + candidate.summary.upload.fallbackCount >= artifactCount
        ),
      30_000
    );
    const shouldDownload = testCase.storageMode === 'local'
      || testCase.driveProfile === 'permanent-failure';
    const downloads = shouldDownload
      ? await waitForCompletedDownloads(
        harness.controlPage,
        harness.downloadsDir,
        artifactCount,
        90_000
      )
      : [];
    if (!shouldDownload) {
      const completedDownloads = (await getDownloads(harness.controlPage))
        .filter((item) => item.state === 'complete');
      if (completedDownloads.length) {
        const finalizerEvents = snapshot.entries.filter(
          (entry) => entry.scope === 'finalizer' || entry.scope === 'drive'
        );
        throw new Error(
          `Drive upload unexpectedly fell back locally: ${JSON.stringify({
            drive,
            upload: snapshot.summary.upload,
            finalizerEvents,
          })}`
        );
      }
    }
    const browserAfter = await collectBrowserMetrics(harness, meetPage);
    const artifacts: MediaArtifactAnalysis[] = [];
    if (downloads.length && testCase.analyzeArtifacts !== false) {
      await assertMediaToolsAvailable();
      for (const download of downloads) {
        const analysis = await analyzeMediaArtifact(download.filename);
        analysis.recordingStream = inferRecordingStream(analysis);
        artifacts.push(analysis);
      }
    }

    const result: PerformanceCaseResult = {
      case: testCase,
      snapshot,
      browserBefore,
      browserAfter,
      browserCpuDeltaSecondsByType: cpuDelta(browserBefore, browserAfter),
      artifacts,
      drive,
      workloadStats,
    };
    await persistResult(testInfo, result);

    assertPerformanceSnapshot(snapshot, testCase);
    for (const artifact of artifacts) {
      assertArtifact(artifact, testCase, snapshot);
    }
    if (artifacts.length) {
      expect(new Set(artifacts.map((artifact) => artifact.recordingStream))).toEqual(
        new Set(expectedStreams(testCase.micMode, testCase.recordSelfVideo))
      );
    }
    if (testCase.storageMode === 'drive') {
      expect(drive?.sessionsCreated).toBe(artifactCount);
      if (testCase.driveProfile === 'permanent-failure') {
        expect(snapshot.summary.upload.fallbackCount).toBe(artifactCount);
      } else {
        expect(snapshot.summary.upload.uploadedCount).toBe(artifactCount);
        expect(drive?.uploadedBytes).toBeGreaterThan(0);
      }
    }

    await debugPage.close();
    return result;
  } finally {
    if (harness) await closeHarness(harness);
  }
}
