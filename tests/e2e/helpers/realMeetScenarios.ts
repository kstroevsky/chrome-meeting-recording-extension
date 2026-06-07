import type { RecordingRunConfig, RecordingStream } from '../../../src/shared/recording';
import type { MediaArtifactAnalysis } from './mediaAnalysis';
import {
  baseRecordingSettings,
  type FullRecordingSettings,
} from './recordingSettings';

export type RealMeetScenario = {
  id: string;
  settings: FullRecordingSettings;
  runConfig: RecordingRunConfig;
  durationMs: number;
  repeatCount?: number;
  expectedStreams: RecordingStream[];
};

export type MediaSignalFinding = {
  metric: 'silence' | 'clipping' | 'black' | 'freeze' | 'av-drift';
  value: number;
  limit: number;
  message: string;
};

function scenario(
  id: string,
  durationMs: number,
  settings: Partial<FullRecordingSettings>,
  runConfig: RecordingRunConfig,
  expectedStreams: RecordingStream[],
  repeatCount?: number
): RealMeetScenario {
  return {
    id,
    durationMs,
    settings: baseRecordingSettings({
      recordingMode: 'opfs',
      ...settings,
    }),
    runConfig,
    expectedStreams,
    ...(repeatCount == null ? {} : { repeatCount }),
  };
}

export function buildRealMeetScenarios(durationMs = 10_000): RealMeetScenario[] {
  return [
    scenario(
      'tab-baseline',
      durationMs,
      {
        micMode: 'off',
        separateCamera: false,
        tabResolutionPreset: '640x360',
        tabMaxFrameRate: 24,
        tabVideoBitrate: 1_500_000,
      },
      { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
      ['tab']
    ),
    scenario(
      'mixed-microphone',
      durationMs,
      {
        micMode: 'mixed',
        separateCamera: false,
        tabResolutionPreset: '1280x720',
        tabMaxFrameRate: 24,
        tabVideoBitrate: 4_000_000,
        micEchoCancellation: true,
        micNoiseSuppression: true,
        micAutoGain: true,
      },
      { storageMode: 'local', micMode: 'mixed', recordSelfVideo: false },
      ['tab']
    ),
    scenario(
      'separate-low-profile',
      durationMs,
      {
        micMode: 'separate',
        separateCamera: true,
        tabResolutionPreset: '854x480',
        tabMaxFrameRate: 24,
        tabVideoBitrate: 2_500_000,
        selfVideoResolutionPreset: '640x360',
        selfVideoFrameRate: 24,
        selfVideoBitrate: 1_000_000,
        selfVideoMinAdaptiveBitrate: 600_000,
        micEchoCancellation: false,
        micNoiseSuppression: true,
        micAutoGain: false,
        chunkDefaultTimesliceMs: 1_000,
        chunkExtendedTimesliceMs: 2_000,
      },
      { storageMode: 'local', micMode: 'separate', recordSelfVideo: true },
      ['tab', 'mic', 'self-video']
    ),
    scenario(
      'separate-high-profile',
      durationMs,
      {
        micMode: 'separate',
        separateCamera: true,
        tabResolutionPreset: '1920x1080',
        tabMaxFrameRate: 30,
        tabVideoBitrate: 8_000_000,
        selfVideoResolutionPreset: '1280x720',
        selfVideoFrameRate: 30,
        selfVideoBitrate: 3_000_000,
        selfVideoMinAdaptiveBitrate: 1_500_000,
        micEchoCancellation: true,
        micNoiseSuppression: false,
        micAutoGain: true,
        chunkDefaultTimesliceMs: 1_500,
        chunkExtendedTimesliceMs: 3_000,
      },
      { storageMode: 'local', micMode: 'separate', recordSelfVideo: true },
      ['tab', 'mic', 'self-video']
    ),
    scenario(
      'device-reacquisition',
      durationMs,
      {
        micMode: 'separate',
        separateCamera: true,
        tabResolutionPreset: '1280x720',
        tabMaxFrameRate: 24,
        tabVideoBitrate: 4_000_000,
        selfVideoResolutionPreset: '854x480',
        selfVideoFrameRate: 24,
        selfVideoBitrate: 1_500_000,
        selfVideoMinAdaptiveBitrate: 1_000_000,
      },
      { storageMode: 'local', micMode: 'separate', recordSelfVideo: true },
      ['tab', 'mic', 'self-video'],
      3
    ),
  ];
}

export function selectRealMeetScenarios(
  scenarios: RealMeetScenario[],
  selectedId?: string
): RealMeetScenario[] {
  if (!selectedId) return scenarios;
  const selected = scenarios.find((candidate) => candidate.id === selectedId);
  if (!selected) {
    throw new Error(
      `Unknown real-Meet scenario "${selectedId}". Available: ${scenarios
        .map((scenario) => scenario.id)
        .join(', ')}`
    );
  }
  return [selected];
}

export function collectMediaSignalFindings(
  artifact: MediaArtifactAnalysis
): MediaSignalFinding[] {
  const duration = artifact.durationSeconds ?? 0;
  const findings: MediaSignalFinding[] = [];
  const silenceLimit = Math.max(5, duration * 0.9);
  const blackLimit = Math.max(1, duration * 0.5);
  const freezeLimit = Math.max(2, duration * 0.75);

  if (artifact.silenceDurationSeconds > silenceLimit) {
    findings.push({
      metric: 'silence',
      value: artifact.silenceDurationSeconds,
      limit: silenceLimit,
      message: 'Audio is silent for most of the artifact',
    });
  }
  if (artifact.audioPeakDb != null && artifact.audioPeakDb > 0) {
    findings.push({
      metric: 'clipping',
      value: artifact.audioPeakDb,
      limit: 0,
      message: 'Audio peak exceeds 0 dB',
    });
  }
  if (artifact.blackDurationSeconds > blackLimit) {
    findings.push({
      metric: 'black',
      value: artifact.blackDurationSeconds,
      limit: blackLimit,
      message: 'Video is black for too much of the artifact',
    });
  }
  if (artifact.freezeDurationSeconds > freezeLimit) {
    findings.push({
      metric: 'freeze',
      value: artifact.freezeDurationSeconds,
      limit: freezeLimit,
      message: 'Video is frozen for too much of the artifact',
    });
  }
  if (artifact.avDurationDriftMs != null && artifact.avDurationDriftMs > 1_500) {
    findings.push({
      metric: 'av-drift',
      value: artifact.avDurationDriftMs,
      limit: 1_500,
      message: 'Audio/video stream durations differ excessively',
    });
  }
  return findings;
}
