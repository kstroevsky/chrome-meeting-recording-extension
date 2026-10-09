import {
  normalizeAutomaticRecordingDestinationRoutes,
  type RecordingDestinationMediaTarget,
  type RecordingDestinationRoute,
} from './recordingDestinations';

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
  /**
   * The "Save to" destination picked at Start. Kept so the end dialog can tell
   * a recording that was never routed from one whose routing failed to write.
   */
  destinationProfileId?: string;
  /** Immutable media choice resolved from the profile when Start was accepted. */
  destinationMediaTarget?: Extract<RecordingDestinationMediaTarget, { kind: 'local' | 'drive' }>;
  /** Immutable expected data routes. Empty is meaningful and must survive normalization. */
  destinationRoutes?: RecordingDestinationRoute[];
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
  const destinationProfileId = normalizeString(candidate.destinationProfileId, 128);
  const destinationMediaTarget = normalizeDestinationMediaTarget(candidate.destinationMediaTarget);
  const destinationRoutes = candidate.destinationRoutes === undefined
    ? undefined
    : normalizeAutomaticRecordingDestinationRoutes(candidate.destinationRoutes);
  return {
    recordingId,
    startedAt,
    ...(endedAt != null && endedAt >= startedAt ? { endedAt } : {}),
    source,
    ...(destinationProfileId ? { destinationProfileId } : {}),
    ...(destinationMediaTarget ? { destinationMediaTarget } : {}),
    ...(destinationRoutes ? { destinationRoutes } : {}),
  };
}

function normalizeDestinationMediaTarget(
  value: unknown,
): RecordingContext['destinationMediaTarget'] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'local' && candidate.kind !== 'drive') return undefined;
  const folderPresetId = candidate.folderPresetId === undefined
    ? undefined
    : normalizeString(candidate.folderPresetId, 128);
  if (candidate.folderPresetId !== undefined && !folderPresetId) return undefined;
  return {
    kind: candidate.kind,
    ...(folderPresetId ? { folderPresetId } : {}),
  };
}

function normalizeSource(value: unknown): RecordingSourceContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'meeting' && candidate.kind !== 'tab') return undefined;

  const provider = normalizeString(candidate.provider, MAX_PROVIDER_LENGTH);
  const meetingId = normalizeString(candidate.meetingId, MAX_MEETING_ID_LENGTH);
  const meetingUrl = normalizeMeetingUrl(
    normalizeString(candidate.meetingUrl, MAX_MEETING_URL_LENGTH),
    provider,
  );
  return {
    kind: candidate.kind,
    ...(provider ? { provider } : {}),
    ...(meetingId ? { meetingId } : {}),
    ...(meetingUrl ? { meetingUrl } : {}),
  };
}

/**
 * Keeps only provider identity-bearing URL material in durable recording context.
 * Google Meet identity is entirely in the path; account/auth routing query
 * parameters and fragments are unnecessary for later external projection.
 */
export function normalizeMeetingUrl(
  value: string | undefined,
  provider: string | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    if (provider === 'google-meet' && url.hostname === 'meet.google.com') {
      url.search = '';
      url.hash = '';
    }
    return url.toString();
  } catch {
    return undefined;
  }
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
