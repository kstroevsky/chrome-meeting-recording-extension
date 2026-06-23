import { test, type TestInfo } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { PerfDebugSnapshot } from '../../src/shared/perf';
import type { RecordingStream } from '../../src/shared/recording';
import {
  SELF_VIDEO_DEFAULT_BITS_PER_SECOND,
  SELF_VIDEO_MIN_ADAPTIVE_BITS_PER_SECOND,
  SELF_VIDEO_QUALITY_FACTOR,
} from '../../src/shared/settings';
import {
  analyzeMediaArtifact,
  assertMediaToolsAvailable,
  type MediaArtifactAnalysis,
} from './helpers/mediaAnalysis';
import {
  collectBrowserMetrics,
  getDownloads,
  probeHardwareMedia,
  sendTabMessage,
  stopRecording,
  type TranscriptResponse,
} from './helpers/extensionHarness';
import {
  assertMeetMediaState,
  bestEffortStop,
  captureMeetDiagnostics,
  closeRealMeetHarness,
  findRealMeetTabId,
  launchRealMeetHarness,
  readMeetMediaState,
  resetRealMeetDiagnostics,
  saveNamedRecordings,
  startRecordingFromExtensionAction,
  waitForFailureInspection,
  waitForCurrentPerfSnapshot,
  waitForNewCompletedDownloads,
  type MeetMediaMode,
  type RealMeetBrowserChannel,
  type RealMeetHarness,
} from './helpers/realMeetHarness';
import {
  buildRealMeetScenarios,
  collectMediaSignalFindings,
  selectRealMeetScenarios,
  type MediaSignalFinding,
  type RealMeetScenario,
} from './helpers/realMeetScenarios';
import { applyFullRecordingSettings } from './helpers/recordingSettings';

type IterationResult = {
  scenarioId: string;
  iteration: number;
  status: 'passed' | 'failed';
  startedAt: string;
  finishedAt: string;
  error?: string;
  settings: RealMeetScenario['settings'];
  runConfig: RealMeetScenario['runConfig'];
  expectedStreams: RecordingStream[];
  meetBefore?: Awaited<ReturnType<typeof readMeetMediaState>>;
  meetDuring?: Awaited<ReturnType<typeof readMeetMediaState>>;
  meetAfter?: Awaited<ReturnType<typeof readMeetMediaState>>;
  snapshot?: PerfDebugSnapshot;
  artifacts?: MediaArtifactAnalysis[];
  signalFindings?: MediaSignalFinding[];
  artifactPaths?: string[];
  namedRecordingPaths?: string[];
};

function lastEntry(
  snapshot: PerfDebugSnapshot,
  scope: string,
  event: string,
  stream?: RecordingStream
): Record<string, string | number | boolean | null> | null {
  const matches = snapshot.entries.filter(
    (entry) =>
      entry.scope === scope
      && entry.event === event
      && (stream == null || entry.fields.stream === stream)
  );
  return matches.length ? matches[matches.length - 1].fields : null;
}

function expectedCaptureStreams(scenario: RealMeetScenario): RecordingStream[] {
  const streams: RecordingStream[] = ['tab'];
  if (scenario.runConfig.micMode !== 'off') streams.push('mic');
  if (scenario.runConfig.recordSelfVideo) streams.push('self-video');
  return streams;
}

function clampTabBitrate(scenario: RealMeetScenario): number {
  const [width, height] = scenario.settings.tabResolutionPreset.split('x').map(Number);
  const ratio =
    (width * height * scenario.settings.tabMaxFrameRate)
    / (1920 * 1080 * 30);
  return Math.min(
    Math.max(Math.round(scenario.settings.tabVideoBitrate * ratio), 250_000),
    8_000_000
  );
}

function assertScenarioSnapshot(
  snapshot: PerfDebugSnapshot,
  scenario: RealMeetScenario
): void {
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.droppedEvents, 0);
  assert.ok(snapshot.entries.length > 0, 'Performance snapshot has no events');
  assert.ok(
    snapshot.summary.lifecycle.startCompletedCount >= 1,
    'Missing start-completed lifecycle event'
  );
  assert.ok(
    snapshot.summary.lifecycle.stopCompletedCount >= 1,
    'Missing stop-completed lifecycle event'
  );
  assert.equal(snapshot.summary.lifecycle.failureCount, 0);
  assert.equal(snapshot.summary.lifecycle.activeTracks, 0);
  assert.equal(snapshot.summary.storage.currentPendingWrites, 0);

  for (const stream of scenario.expectedStreams) {
    assert.ok(
      (snapshot.summary.recorder.startCountByStream[stream] ?? 0) >= 1,
      `Missing recorder start for ${stream}`
    );
    assert.ok(
      (snapshot.summary.recorder.chunkCountByStream[stream] ?? 0) >= 1,
      `Missing recorder chunks for ${stream}`
    );
    assert.ok(
      (snapshot.summary.recorder.lastArtifactBytesByStream[stream] ?? 0) > 0,
      `Missing sealed artifact bytes for ${stream}`
    );
  }

  for (const stream of expectedCaptureStreams(scenario)) {
    assert.ok(
      (snapshot.summary.capture.successCountByStream[stream] ?? 0) >= 1,
      `Missing successful capture for ${stream}`
    );
  }

  const tabCapture = lastEntry(snapshot, 'capture', 'stream_acquired', 'tab');
  const tabRecorder = lastEntry(snapshot, 'recorder', 'recorder_started', 'tab');
  const [tabWidth, tabHeight] = scenario.settings.tabResolutionPreset
    .split('x')
    .map(Number);
  assert.equal(tabCapture?.requestedWidth, tabWidth);
  assert.equal(tabCapture?.requestedHeight, tabHeight);
  assert.equal(
    tabCapture?.requestedFrameRate,
    scenario.settings.tabMaxFrameRate
  );
  assert.equal(tabRecorder?.videoBitsPerSecond, clampTabBitrate(scenario));
  assert.equal(
    tabRecorder?.timesliceMs,
    scenario.settings.chunkExtendedTimesliceMs
  );

  if (scenario.runConfig.micMode !== 'off') {
    const microphoneCapture = lastEntry(
      snapshot,
      'capture',
      'stream_acquired',
      'mic'
    );
    assert.equal(
      microphoneCapture?.requestedEchoCancellation,
      scenario.settings.micEchoCancellation
    );
    assert.equal(
      microphoneCapture?.requestedNoiseSuppression,
      scenario.settings.micNoiseSuppression
    );
    assert.equal(
      microphoneCapture?.requestedAutoGainControl,
      scenario.settings.micAutoGain
    );
  }

  if (scenario.runConfig.micMode === 'separate') {
    const microphoneRecorder = lastEntry(
      snapshot,
      'recorder',
      'recorder_started',
      'mic'
    );
    assert.equal(
      microphoneRecorder?.timesliceMs,
      scenario.settings.chunkDefaultTimesliceMs
    );
  }

  if (scenario.runConfig.recordSelfVideo) {
    const cameraCapture = lastEntry(
      snapshot,
      'capture',
      'stream_acquired',
      'self-video'
    );
    const cameraRecorder = lastEntry(
      snapshot,
      'recorder',
      'recorder_started',
      'self-video'
    );
    const [cameraWidth, cameraHeight] = scenario.settings.selfVideoResolutionPreset
      .split('x')
      .map(Number);
    assert.equal(cameraCapture?.requestedWidth, cameraWidth);
    assert.equal(cameraCapture?.requestedHeight, cameraHeight);
    assert.equal(
      cameraCapture?.requestedFrameRate,
      scenario.settings.selfVideoFrameRate
    );
    // Camera bitrate is automatic (adaptive default on): clamp the delivered
    // W×H×fps estimate to the internal floor/ceiling, falling back to the
    // ceiling when the delivered dimensions are unavailable. Mirrors
    // resolveSelfVideoBitrate().
    const camW = Number(cameraCapture?.width);
    const camH = Number(cameraCapture?.height);
    const camFps = Number(cameraCapture?.frameRate);
    const expectedCameraBitrate = camW && camH && camFps
      ? Math.min(
          Math.max(Math.round(camW * camH * camFps * SELF_VIDEO_QUALITY_FACTOR), SELF_VIDEO_MIN_ADAPTIVE_BITS_PER_SECOND),
          SELF_VIDEO_DEFAULT_BITS_PER_SECOND
        )
      : SELF_VIDEO_DEFAULT_BITS_PER_SECOND;
    assert.equal(cameraRecorder?.videoBitsPerSecond, expectedCameraBitrate);
    assert.equal(
      cameraRecorder?.timesliceMs,
      scenario.settings.chunkExtendedTimesliceMs
    );
  }
}

function inferRecordingStream(artifact: MediaArtifactAnalysis): RecordingStream {
  const hasVideo = artifact.streams.some((stream) => stream.codecType === 'video');
  const hasAudio = artifact.streams.some((stream) => stream.codecType === 'audio');
  if (hasVideo && hasAudio) return 'tab';
  if (hasAudio) return 'mic';
  if (hasVideo) return 'self-video';
  throw new Error(`Artifact has no audio or video streams: ${artifact.path}`);
}

function assertArtifact(
  artifact: MediaArtifactAnalysis,
  scenario: RealMeetScenario
): void {
  assert.ok((artifact.sizeBytes ?? 0) > 0, `Artifact is empty: ${artifact.path}`);
  assert.ok(
    (artifact.durationSeconds ?? 0) > (scenario.durationMs / 1_000) * 0.45,
    `Artifact duration is too short: ${artifact.path}`
  );
  assert.match(artifact.formatName ?? '', /webm/);

  const video = artifact.streams.find((stream) => stream.codecType === 'video');
  const audio = artifact.streams.find((stream) => stream.codecType === 'audio');
  if (artifact.recordingStream === 'tab') {
    assert.ok(video, 'Tab artifact has no video stream');
    assert.ok(audio, 'Tab artifact has no audio stream');
  } else if (artifact.recordingStream === 'mic') {
    assert.ok(audio, 'Microphone artifact has no audio stream');
    assert.equal(video, undefined, 'Microphone artifact unexpectedly has video');
  } else {
    assert.ok(video, 'Camera artifact has no video stream');
    assert.equal(audio, undefined, 'Camera artifact unexpectedly has audio');
  }
  if (video) {
    assert.match(video.codecName ?? '', /vp8|vp9|av1/);
    assert.ok((video.width ?? 0) > 0 && (video.height ?? 0) > 0);
    assert.ok((video.frameCount ?? 0) > 0);
    // The encoded resolution must match the requested preset — not merely be
    // non-zero. This guards the camera-contention leak where a shared camera
    // recorded its native size (e.g. 1280x720) instead of the chosen preset.
    const preset =
      artifact.recordingStream === 'tab'
        ? scenario.settings.tabResolutionPreset
        : artifact.recordingStream === 'self-video'
          ? scenario.settings.selfVideoResolutionPreset
          : null;
    if (preset) {
      const [expectedWidth, expectedHeight] = preset.split('x').map(Number);
      assert.equal(
        video.width,
        expectedWidth,
        `${artifact.recordingStream} encoded width ${video.width} != requested ${expectedWidth} (preset ${preset})`
      );
      assert.equal(
        video.height,
        expectedHeight,
        `${artifact.recordingStream} encoded height ${video.height} != requested ${expectedHeight} (preset ${preset})`
      );
    }
  }
  if (audio) assert.match(audio.codecName ?? '', /opus|vorbis/);
}

async function attachJson(
  testInfo: TestInfo,
  name: string,
  data: unknown
): Promise<string> {
  const filePath = testInfo.outputPath(`${name}.json`);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
  await testInfo.attach(name, {
    path: filePath,
    contentType: 'application/json',
  });
  return filePath;
}

async function runIteration(
  testInfo: TestInfo,
  harness: RealMeetHarness,
  scenario: RealMeetScenario,
  iteration: number,
  strictMedia: boolean
): Promise<IterationResult> {
  const startedAt = new Date().toISOString();
  const result: IterationResult = {
    scenarioId: scenario.id,
    iteration,
    status: 'failed',
    startedAt,
    finishedAt: startedAt,
    settings: scenario.settings,
    runConfig: scenario.runConfig,
    expectedStreams: scenario.expectedStreams,
  };
  const artifactPrefix = `${scenario.id}-${iteration}`;
  let existingDownloadIds = new Set<number>();
  let downloadBaselineCaptured = false;

  try {
    existingDownloadIds = new Set(
      (await getDownloads(harness.controlPage)).map((download) => download.id)
    );
    downloadBaselineCaptured = true;
    await resetRealMeetDiagnostics(harness.controlPage);
    await applyFullRecordingSettings(harness.controlPage, scenario.settings);
    result.meetBefore = await readMeetMediaState(harness.meetPage);
    assertMeetMediaState(result.meetBefore, harness.meetMedia);

    const meetTabId = await findRealMeetTabId(harness.controlPage);

    await startRecordingFromExtensionAction(harness, meetTabId);
    result.meetDuring = await readMeetMediaState(harness.meetPage);
    assertMeetMediaState(result.meetDuring, harness.meetMedia);
    await harness.controlPage.waitForTimeout(scenario.durationMs);

    await stopRecording(harness.controlPage);
    result.snapshot = await waitForCurrentPerfSnapshot(harness.controlPage, 120_000);
    assertScenarioSnapshot(result.snapshot, scenario);
    result.meetAfter = await readMeetMediaState(harness.meetPage);
    assertMeetMediaState(result.meetAfter, harness.meetMedia);

    const downloads = await waitForNewCompletedDownloads(
      harness.controlPage,
      harness.downloadsDir,
      existingDownloadIds,
      scenario.expectedStreams.length,
      120_000
    );
    result.artifactPaths = downloads.map((download) => download.filename);
    const artifacts: MediaArtifactAnalysis[] = [];
    for (const download of downloads) {
      const preliminary = await analyzeMediaArtifact(download.filename);
      const recordingStream = inferRecordingStream(preliminary);
      artifacts.push({ ...preliminary, recordingStream });
    }
    const actualStreams = artifacts
      .map((artifact) => artifact.recordingStream)
      .sort();
    assert.deepEqual(actualStreams, [...scenario.expectedStreams].sort());
    for (const artifact of artifacts) assertArtifact(artifact, scenario);
    result.artifacts = artifacts;
    result.namedRecordingPaths = await saveNamedRecordings(
      scenario.id,
      iteration,
      artifacts
    );
    result.signalFindings = artifacts.flatMap(collectMediaSignalFindings);
    if (strictMedia && result.signalFindings.length > 0) {
      throw new Error(
        `Strict media checks failed: ${result.signalFindings
          .map((finding) => `${finding.metric}=${finding.value}`)
          .join(', ')}`
      );
    }

    result.status = 'passed';
  } catch (error) {
    result.error = error instanceof Error ? error.stack ?? error.message : String(error);
    await bestEffortStop(harness);
    await harness.controlPage.waitForTimeout(1_000).catch(() => {});
    const failedArtifacts = downloadBaselineCaptured
      ? (await getDownloads(harness.controlPage).catch(() => []))
      .filter(
        (download) =>
          !existingDownloadIds.has(download.id)
          && download.state === 'complete'
          && download.exists !== false
      )
      .map((download) => download.filename)
      : [];
    result.artifactPaths = [...new Set([
      ...(result.artifactPaths ?? []),
      ...failedArtifacts,
    ])];
    for (const [index, artifactPath] of result.artifactPaths.entries()) {
      await testInfo.attach(`${artifactPrefix}-failed-media-${index + 1}`, {
        path: artifactPath,
        contentType: 'video/webm',
      }).catch(() => {});
    }
    await captureMeetDiagnostics(
      harness.meetPage,
      (name) => testInfo.outputPath(name),
      `${artifactPrefix}-failure`
    ).catch(() => {});
  } finally {
    result.finishedAt = new Date().toISOString();
    await attachJson(testInfo, `${artifactPrefix}-result`, result);
    if (result.snapshot) {
      await attachJson(
        testInfo,
        `${artifactPrefix}-perf-debug-snapshot`,
        result.snapshot
      );
    }
  }
  return result;
}

test('runs the reusable real Google Meet calibration matrix with one admission', async (
  {},
  testInfo
) => {
  test.setTimeout(30 * 60_000);
  const meetUrl = process.env.MEET_URL;
  if (!meetUrl) {
    throw new Error(
      'MEET_URL is required. Use: npm run test:e2e:real -- https://meet.google.com/abc-defg-hij'
    );
  }

  const recordSeconds = Number(process.env.RECORD_SECONDS ?? '10');
  if (!Number.isFinite(recordSeconds) || recordSeconds < 1) {
    throw new Error('RECORD_SECONDS must be a finite number >= 1');
  }
  const joinTimeoutMs = Number(process.env.JOIN_TIMEOUT_MS ?? '240000');
  if (!Number.isFinite(joinTimeoutMs) || joinTimeoutMs < 1_000) {
    throw new Error('JOIN_TIMEOUT_MS must be a finite number >= 1000');
  }
  const meetMedia = (process.env.REAL_MEET_MEDIA ?? 'on') as MeetMediaMode;
  if (meetMedia !== 'on' && meetMedia !== 'off') {
    throw new Error('REAL_MEET_MEDIA must be "on" or "off"');
  }
  const browserChannel = (
    process.env.REAL_MEET_BROWSER ?? 'chrome'
  ) as RealMeetBrowserChannel;
  if (
    browserChannel !== 'chrome'
    && browserChannel !== 'chrome-for-testing'
  ) {
    throw new Error(
      'REAL_MEET_BROWSER must be "chrome" or "chrome-for-testing"'
    );
  }

  const scenarios = selectRealMeetScenarios(
    buildRealMeetScenarios(recordSeconds * 1_000),
    process.env.REAL_MEET_SCENARIO
  );
  const strictMedia = process.env.REAL_MEET_STRICT_MEDIA === '1';
  const guestName = process.env.MEET_NAME ?? 'Codex Recorder Test';
  await assertMediaToolsAvailable();

  let harness: RealMeetHarness | null = null;
  const results: IterationResult[] = [];
  let hardwareAfterMatrix: Awaited<ReturnType<typeof probeHardwareMedia>> | null = null;
  let browserAfterMatrix: Awaited<ReturnType<typeof collectBrowserMetrics>> | null = null;
  let setupError: string | null = null;
  try {
    const launched = await launchRealMeetHarness(testInfo, {
      meetUrl,
      guestName,
      meetMedia,
      browserChannel,
      joinTimeoutMs,
    });
    harness = launched.harness;
    await attachJson(testInfo, 'hardware-and-permissions', launched.hardware);
    await attachJson(testInfo, 'selected-real-meet-scenarios', scenarios);
    const meetTabId = await findRealMeetTabId(harness.controlPage);
    const provider = await sendTabMessage<TranscriptResponse>(
      harness.controlPage,
      meetTabId,
      { type: 'GET_TRANSCRIPT' }
    );
    assert.equal(provider.provider.providerId, 'google-meet');
    assert.equal(provider.provider.supportsCaptions, true);
    await attachJson(testInfo, 'real-meet-content-script-provider', provider.provider);

    for (const scenario of scenarios) {
      const repeatCount = scenario.repeatCount ?? 1;
      for (let iteration = 1; iteration <= repeatCount; iteration += 1) {
        console.log(
          `Running live scenario ${scenario.id} (${iteration}/${repeatCount})`
        );
        results.push(
          await runIteration(
            testInfo,
            harness,
            scenario,
            iteration,
            strictMedia
          )
        );
      }
    }
    browserAfterMatrix = await collectBrowserMetrics(harness, harness.meetPage);
    await attachJson(testInfo, 'browser-after-matrix', browserAfterMatrix);
    hardwareAfterMatrix = await probeHardwareMedia(harness);
    await attachJson(testInfo, 'hardware-after-matrix', hardwareAfterMatrix);
    if (!hardwareAfterMatrix.ok) {
      throw new Error(
        `Camera/microphone could not be reacquired after the live matrix: ${
          hardwareAfterMatrix.error ?? 'missing tracks'
        }`
      );
    }
  } catch (error) {
    setupError = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    const failed = results.filter((result) => result.status === 'failed');
    const failureReason = setupError
      ?? failed[0]?.error
      ?? null;
    if (harness) {
      if (failureReason) {
        await waitForFailureInspection(failureReason);
      }
      await closeRealMeetHarness(harness, failureReason != null);
      if (failureReason) {
        await testInfo.attach('real-meet-trace', {
          path: harness.tracePath,
          contentType: 'application/zip',
        }).catch(() => {});
      }
    }
  }

  const failed = results.filter((result) => result.status === 'failed');
  await attachJson(testInfo, 'real-meet-aggregate-report', {
    meetUrl,
    guestName,
    meetMedia,
    browserChannel,
    accountMode: harness?.accountMode ?? null,
    traceAvailable: false,
    traceUnavailableReason:
      'Starting Playwright tracing invalidates real Chrome tab-capture stream IDs in this context.',
    hardwareAfterMatrix,
    browserAfterMatrix,
    strictMedia,
    setupError,
    startedScenarios: scenarios.map((scenario) => scenario.id),
    passedIterations: results.length - failed.length,
    failedIterations: failed.length,
    results,
  });

  if (setupError) throw new Error(setupError);
  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${results.length} real-Meet iteration(s) failed:\n${failed
        .map(
          (result) =>
            `- ${result.scenarioId}#${result.iteration}: ${
              result.error?.split('\n')[0] ?? 'unknown error'
            }`
        )
        .join('\n')}`
    );
  }
});
