/**
 * @file shared/types/settingsTypes.ts
 *
 * Interfaces, types, and schemas for extension configuration and snapshots.
 */

import type { MicMode } from '../recordingTypes';

export type RecordingModeDefault = 'opfs' | 'drive';
export type ResolutionPreset = '640x360' | '854x480' | '1280x720' | '1920x1080';

export type LegacyVideoFormat = 1080 | 720 | 480 | 360;
export type ResolutionDimensions = {
  width: number;
  height: number;
};

export type ExtensionSettings = {
  basic: {
    recordingMode: RecordingModeDefault;
    microphoneRecordingMode: MicMode;
    separateCameraCapture: boolean;
    selfVideoResolutionPreset: ResolutionPreset;
  };
  professional: {
    selfVideoBitrate: number;
    selfVideoFrameRate: number;
    selfVideoMinAdaptiveBitrate: number;
    tabResolutionPreset: ResolutionPreset;
    tabMaxFrameRate: number;
    microphoneEchoCancellation: boolean;
    microphoneNoiseSuppression: boolean;
    microphoneAutoGainControl: boolean;
    chunkDefaultTimesliceMs: number;
    chunkExtendedTimesliceMs: number;
  };
};

export type SelfVideoProfileSettings = {
  width: number;
  height: number;
  frameRate: number;
  aspectRatio: number;
  defaultBitsPerSecond: number;
  minAdaptiveBitsPerSecond: number;
};

export type TabCaptureSettings = {
  maxWidth: number;
  maxHeight: number;
  maxFrameRate: number;
};

export type MicrophoneCaptureSettings = {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
};

export type ChunkingSettings = {
  defaultTimesliceMs: number;
  extendedTimesliceMs: number;
};

export type RecorderRuntimeSettingsSnapshot = {
  tab: {
    output: TabCaptureSettings;
  };
  selfVideo: {
    profile: SelfVideoProfileSettings;
  };
  microphone: MicrophoneCaptureSettings;
  chunking: ChunkingSettings;
};
