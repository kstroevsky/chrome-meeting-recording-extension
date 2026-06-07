import {
  buildRealMeetScenarios,
  collectMediaSignalFindings,
  selectRealMeetScenarios,
} from './e2e/helpers/realMeetScenarios';
import type { MediaArtifactAnalysis } from './e2e/helpers/mediaAnalysis';

function artifact(
  overrides: Partial<MediaArtifactAnalysis> = {}
): MediaArtifactAnalysis {
  return {
    path: '/tmp/test.webm',
    recordingStream: 'tab',
    formatName: 'matroska,webm',
    durationSeconds: 10,
    sizeBytes: 1_000,
    bitrate: 800_000,
    streams: [
      {
        codecType: 'video',
        codecName: 'vp8',
        durationSeconds: 10,
        width: 640,
        height: 360,
        averageFps: 24,
        frameCount: 240,
        bitrate: 700_000,
      },
      {
        codecType: 'audio',
        codecName: 'opus',
        durationSeconds: 10,
        width: null,
        height: null,
        averageFps: null,
        frameCount: null,
        bitrate: 100_000,
      },
    ],
    blackDurationSeconds: 0,
    freezeDurationSeconds: 0,
    silenceDurationSeconds: 0,
    audioRmsDb: -24,
    audioPeakDb: -3,
    avDurationDriftMs: 20,
    markerDriftMs: null,
    optionalMetricsUnavailable: [],
    ...overrides,
  };
}

test('builds the reusable one-admission calibration matrix', () => {
  const scenarios = buildRealMeetScenarios(4_000);

  expect(scenarios.map((scenario) => scenario.id)).toEqual([
    'tab-baseline',
    'mixed-microphone',
    'separate-low-profile',
    'separate-high-profile',
    'device-reacquisition',
  ]);
  expect(scenarios.every((scenario) => scenario.durationMs === 4_000)).toBe(true);
  expect(scenarios[0].expectedStreams).toEqual(['tab']);
  expect(scenarios[1].runConfig.micMode).toBe('mixed');
  expect(scenarios[1].expectedStreams).toEqual(['tab']);
  expect(scenarios[2].expectedStreams).toEqual(['tab', 'mic', 'self-video']);
  expect(scenarios[3].settings.tabResolutionPreset).toBe('1920x1080');
  expect(scenarios[4].repeatCount).toBe(3);
});

test('selects one scenario or rejects an unknown id before admission', () => {
  const scenarios = buildRealMeetScenarios();

  expect(selectRealMeetScenarios(scenarios).length).toBe(5);
  expect(selectRealMeetScenarios(scenarios, 'separate-low-profile')).toHaveLength(1);
  expect(() => selectRealMeetScenarios(scenarios, 'missing')).toThrow(
    /Unknown real-Meet scenario "missing"/
  );
});

test('classifies real-device signal quality as reportable findings', () => {
  const findings = collectMediaSignalFindings(artifact({
    blackDurationSeconds: 6,
    freezeDurationSeconds: 8,
    silenceDurationSeconds: 9.5,
    audioPeakDb: 0.5,
    avDurationDriftMs: 2_000,
  }));

  expect(findings.map((finding) => finding.metric)).toEqual([
    'silence',
    'clipping',
    'black',
    'freeze',
    'av-drift',
  ]);
});
