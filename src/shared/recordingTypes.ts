/**
 * @file shared/recordingTypes.ts
 *
 * Recording domain types shared across popup, background, and offscreen
 * contexts.
 */

export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'uploading' | 'failed';
export type RecordingStream = 'tab' | 'mic' | 'selfVideo';
export type StorageMode = 'local' | 'drive';
export type MicMode = 'off' | 'mixed' | 'separate';

export type RecordingRunConfig = {
  storageMode: StorageMode;
  micMode: MicMode;
  recordSelfVideo: boolean;
};

export type UploadSummaryEntry = {
  stream: RecordingStream;
  filename: string;
  error?: string;
};

export type UploadSummary = {
  uploaded: UploadSummaryEntry[];
  localFallbacks: UploadSummaryEntry[];
};

export type RecordingSessionSnapshot = {
  phase: RecordingPhase;
  runConfig: RecordingRunConfig | null;
  uploadSummary?: UploadSummary;
  error?: string;
  updatedAt: number;
};
