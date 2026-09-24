export type RecordingSourceContext = {
  kind: 'meeting' | 'tab';
  provider?: string;
  meetingId?: string;
  meetingUrl?: string;
};

export type RecordingContext = {
  recordingId: string;
  startedAt: number;
  endedAt?: number;
  source: RecordingSourceContext;
};

const MAX_PROVIDER_LENGTH = 128;
const MAX_MEETING_ID_LENGTH = 512;
const MAX_MEETING_URL_LENGTH = 4096;

export function normalizeRecordingContext(value: unknown): RecordingContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const recordingId = normalizeString(candidate.recordingId, 512);
  const startedAt = normalizeTimestamp(candidate.startedAt);
  const source = normalizeSource(candidate.source);
  if (!recordingId || startedAt == null || !source) return undefined;

  const endedAt = normalizeTimestamp(candidate.endedAt);
  return {
    recordingId,
    startedAt,
    ...(endedAt != null && endedAt >= startedAt ? { endedAt } : {}),
    source,
  };
}

function normalizeSource(value: unknown): RecordingSourceContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'meeting' && candidate.kind !== 'tab') return undefined;

  const provider = normalizeString(candidate.provider, MAX_PROVIDER_LENGTH);
  const meetingId = normalizeString(candidate.meetingId, MAX_MEETING_ID_LENGTH);
  const meetingUrl = normalizeString(candidate.meetingUrl, MAX_MEETING_URL_LENGTH);
  return {
    kind: candidate.kind,
    ...(provider ? { provider } : {}),
    ...(meetingId ? { meetingId } : {}),
    ...(meetingUrl ? { meetingUrl } : {}),
  };
}

function normalizeTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}
