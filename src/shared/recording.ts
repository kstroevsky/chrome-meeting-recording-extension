/**
 * @file shared/recording.ts
 *
 * Shared recording domain model: phases, run configuration, upload summaries,
 * persisted session snapshots, and normalization helpers.
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

export const DEFAULT_RECORDING_RUN_CONFIG: Readonly<RecordingRunConfig> = {
  storageMode: 'drive',
  micMode: 'separate',
  recordSelfVideo: true,
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

export const RECORDING_SESSION_STORAGE_KEY = 'recordingSession';
const NON_IDLE_PHASES: RecordingPhase[] = ['starting', 'recording', 'stopping', 'uploading', 'failed'];
const VALID_STORAGE_MODES: StorageMode[] = ['local', 'drive'];
const VALID_MIC_MODES: MicMode[] = ['off', 'mixed', 'separate'];

function isRecord<T extends object>(value: unknown): value is Partial<T> {
  return !!value && typeof value === 'object';
}

export function normalizePhase(value: unknown): RecordingPhase {
  return typeof value === 'string' && NON_IDLE_PHASES.includes(value as RecordingPhase)
    ? value as RecordingPhase
    : 'idle';
}

export function normalizeStorageMode(value: unknown): StorageMode {
  return typeof value === 'string' && VALID_STORAGE_MODES.includes(value as StorageMode)
    ? value as StorageMode
    : DEFAULT_RECORDING_RUN_CONFIG.storageMode;
}

export function normalizeMicMode(value: unknown): MicMode {
  return typeof value === 'string' && VALID_MIC_MODES.includes(value as MicMode)
    ? value as MicMode
    : DEFAULT_RECORDING_RUN_CONFIG.micMode;
}

export function createDefaultRunConfig(): RecordingRunConfig {
  return { ...DEFAULT_RECORDING_RUN_CONFIG };
}

export function normalizeRunConfig(value: unknown): RecordingRunConfig | null {
  if (!isRecord<RecordingRunConfig>(value)) return null;
  const candidate = value;

  return {
    storageMode: normalizeStorageMode(candidate.storageMode),
    micMode: normalizeMicMode(candidate.micMode),
    recordSelfVideo:
      typeof candidate.recordSelfVideo === 'boolean'
        ? candidate.recordSelfVideo
        : DEFAULT_RECORDING_RUN_CONFIG.recordSelfVideo,
  };
}

export function getRunConfigOrDefault(value: unknown): RecordingRunConfig {
  return normalizeRunConfig(value) ?? createDefaultRunConfig();
}

function normalizeUploadSummaryEntry(entry: unknown): UploadSummaryEntry | null {
  if (!isRecord<UploadSummaryEntry>(entry)) return null;

  const stream =
    entry.stream === 'mic' || entry.stream === 'selfVideo' ? entry.stream : 'tab';
  const filename = typeof entry.filename === 'string' ? entry.filename.trim() : '';
  if (!filename) return null;
  const error = typeof entry.error === 'string' ? entry.error.trim() : '';

  return {
    stream,
    filename,
    error: error || undefined,
  };
}

export function normalizeUploadSummary(value: unknown): UploadSummary | undefined {
  if (!isRecord<UploadSummary>(value)) return undefined;
  const candidate = value;

  const normalizeEntries = (entries: unknown): UploadSummaryEntry[] => {
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => normalizeUploadSummaryEntry(entry))
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
  };

  return {
    uploaded: normalizeEntries(candidate.uploaded),
    localFallbacks: normalizeEntries(candidate.localFallbacks),
  };
}

export function createIdleSession(now = Date.now()): RecordingSessionSnapshot {
  return {
    phase: 'idle',
    runConfig: null,
    updatedAt: now,
  };
}

export function normalizeSessionSnapshot(value: unknown): RecordingSessionSnapshot {
  if (!isRecord<RecordingSessionSnapshot>(value)) return createIdleSession();
  const candidate = value;
  const phase = normalizePhase(candidate.phase);
  const runConfig = phase === 'idle' ? null : normalizeRunConfig(candidate.runConfig);

  return {
    phase,
    runConfig,
    uploadSummary: normalizeUploadSummary(candidate.uploadSummary),
    error: typeof candidate.error === 'string' && candidate.error.trim() ? candidate.error : undefined,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
  };
}

export function isBusyPhase(phase: RecordingPhase): boolean {
  return phase === 'starting' || phase === 'recording' || phase === 'stopping' || phase === 'uploading';
}
