export type RecordingPhase = 'idle' | 'starting' | 'recording' | 'stopping' | 'uploading' | 'failed';
export type RecordingStream = 'tab' | 'mic' | 'selfVideo';
export type StorageMode = 'local' | 'drive';
export type MicMode = 'off' | 'mixed' | 'separate';
export type SelfVideoQuality = 'standard' | 'high';

export type RecordingRunConfig = {
  storageMode: StorageMode;
  micMode: MicMode;
  recordSelfVideo: boolean;
  selfVideoQuality: SelfVideoQuality;
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

export function normalizePhase(value: unknown): RecordingPhase {
  switch (value) {
    case 'starting':
    case 'recording':
    case 'stopping':
    case 'uploading':
    case 'failed':
      return value;
    default:
      return 'idle';
  }
}

export function normalizeStorageMode(value: unknown): StorageMode {
  return value === 'drive' ? 'drive' : 'local';
}

export function normalizeMicMode(value: unknown): MicMode {
  switch (value) {
    case 'mixed':
    case 'separate':
      return value;
    default:
      return 'off';
  }
}

export function normalizeSelfVideoQuality(value: unknown): SelfVideoQuality {
  return value === 'high' ? 'high' : 'standard';
}

export function normalizeRunConfig(value: unknown): RecordingRunConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<RecordingRunConfig>;

  return {
    storageMode: normalizeStorageMode(candidate.storageMode),
    micMode: normalizeMicMode(candidate.micMode),
    recordSelfVideo: candidate.recordSelfVideo === true,
    selfVideoQuality: normalizeSelfVideoQuality(candidate.selfVideoQuality),
  };
}

export function normalizeUploadSummary(value: unknown): UploadSummary | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<UploadSummary>;

  const normalizeEntries = (entries: unknown): UploadSummaryEntry[] => {
    if (!Array.isArray(entries)) return [];
    return entries
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const record = entry as Partial<UploadSummaryEntry>;
        const stream =
          record.stream === 'mic' || record.stream === 'selfVideo' ? record.stream : 'tab';
        const filename = typeof record.filename === 'string' ? record.filename.trim() : '';
        if (!filename) return null;
        return {
          stream,
          filename,
          error: typeof record.error === 'string' && record.error.trim() ? record.error : undefined,
        } satisfies UploadSummaryEntry;
      })
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
  if (!value || typeof value !== 'object') return createIdleSession();
  const candidate = value as Partial<RecordingSessionSnapshot>;
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
