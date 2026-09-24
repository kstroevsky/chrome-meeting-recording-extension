import type {
  PublishedPlaybackManifest,
  SharedPlaybackTrack,
  SharedRecording,
} from './sharing';

export const SHARING_CONTRACT_LIMITS = Object.freeze({
  /** Canonical JSON persisted in D1. Leaves headroom below D1's 2 MB row/string limit. */
  manifestBytes: 1_500_000,
  /** Raw owner request budget; canonical JSON is checked separately before persistence. */
  manifestRequestBytes: 2_000_000,
  recordings: 16,
  tracksPerRecording: 3,
  publishedBytes: 100 * 1024 * 1024 * 1024,
  idChars: 200,
  titleChars: 500,
  mimeTypeChars: 200,
  transcriptSegments: 10_000,
  transcriptTextChars: 750_000,
  speakerChars: 500,
  topics: 250,
  topicKeywords: 24,
  keywordChars: 120,
  topicKeywordTextChars: 60_000,
  topicSpans: 100,
  topicSpansTotal: 5_000,
  notations: 2_000,
  notationTextChars: 2_000,
  notationTextTotalChars: 250_000,
});

type ParseBudget = {
  transcriptTextChars: number;
  publishedBytes: number;
  topicKeywordTextChars: number;
  topicSpans: number;
  notationTextChars: number;
};

export function canonicalizePublishedManifest(
  value: unknown,
  expectedShareId: string,
): PublishedPlaybackManifest | null {
  if (!boundedId(expectedShareId) || !isRecord(value) || value.id !== expectedShareId || !isFiniteNumber(value.createdAt)) return null;
  if (!Array.isArray(value.recordings) || value.recordings.length === 0 || value.recordings.length > SHARING_CONTRACT_LIMITS.recordings) return null;

  const recordingIds = new Set<string>();
  const recordings: SharedRecording[] = [];
  const budget: ParseBudget = {
    transcriptTextChars: 0,
    publishedBytes: 0,
    topicKeywordTextChars: 0,
    topicSpans: 0,
    notationTextChars: 0,
  };
  for (const rawRecording of value.recordings) {
    const recording = canonicalRecording(rawRecording, recordingIds, budget);
    if (!recording) return null;
    recordings.push(recording);
  }
  return { id: expectedShareId, createdAt: value.createdAt, recordings };
}

export function canonicalizeStoredPublishedManifest(
  manifestJson: string,
  expectedShareId: string,
): PublishedPlaybackManifest | null {
  if (utf8Bytes(manifestJson) > SHARING_CONTRACT_LIMITS.manifestBytes) return null;
  try {
    return canonicalizePublishedManifest(JSON.parse(manifestJson), expectedShareId);
  } catch {
    return null;
  }
}

function canonicalRecording(value: unknown, recordingIds: Set<string>, budget: ParseBudget): SharedRecording | null {
  if (!isRecord(value) || !boundedId(value.id) || recordingIds.has(value.id)) return null;
  if (typeof value.title !== 'string' || value.title.length > SHARING_CONTRACT_LIMITS.titleChars || !isFiniteNumber(value.createdAt)) return null;
  if (value.durationMs != null && !isNonNegativeFiniteNumber(value.durationMs)) return null;
  if (!Array.isArray(value.tracks) || value.tracks.length === 0 || value.tracks.length > SHARING_CONTRACT_LIMITS.tracksPerRecording || typeof value.downloadsEnabled !== 'boolean') return null;

  recordingIds.add(value.id);
  const trackIds = new Set<string>();
  const tracks: SharedPlaybackTrack[] = [];
  for (const rawTrack of value.tracks) {
    const track = canonicalTrack(rawTrack, value.id, trackIds, budget);
    if (!track) return null;
    tracks.push(track);
  }

  const transcript = value.transcript == null ? undefined : canonicalTranscript(value.transcript, budget);
  if (value.transcript != null && !transcript) return null;
  const topics = value.topics == null ? undefined : canonicalTopics(value.topics, budget);
  if (value.topics != null && !topics) return null;
  const notations = value.notations == null ? undefined : canonicalNotations(value.notations, budget);
  if (value.notations != null && !notations) return null;

  return {
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    ...(value.durationMs != null ? { durationMs: value.durationMs } : {}),
    tracks,
    ...(transcript ? { transcript } : {}),
    ...(topics ? { topics } : {}),
    ...(notations ? { notations } : {}),
    downloadsEnabled: value.downloadsEnabled,
  };
}

function canonicalTrack(value: unknown, recordingId: string, trackIds: Set<string>, budget: ParseBudget): SharedPlaybackTrack | null {
  if (!isRecord(value) || !boundedId(value.id) || trackIds.has(value.id)) return null;
  if (value.stream !== 'tab' && value.stream !== 'mic' && value.stream !== 'self-video') return null;
  if (!isNonEmptyString(value.mimeType) || value.mimeType.length > SHARING_CONTRACT_LIMITS.mimeTypeChars || !isFiniteNumber(value.captureStartOffsetMs)) return null;
  if (value.bytes != null && (!Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0)) return null;

  const expectedEndpoint = `/media/recordings/${encodeURIComponent(recordingId)}/tracks/${encodeURIComponent(value.id)}`;
  if (value.mediaEndpoint !== expectedEndpoint) return null;
  const bytes = value.bytes == null ? undefined : Number(value.bytes);
  if (bytes != null) {
    budget.publishedBytes += bytes;
    if (budget.publishedBytes > SHARING_CONTRACT_LIMITS.publishedBytes) return null;
  }

  trackIds.add(value.id);
  return {
    id: value.id,
    stream: value.stream,
    mimeType: value.mimeType,
    ...(bytes != null ? { bytes } : {}),
    captureStartOffsetMs: value.captureStartOffsetMs,
    mediaEndpoint: expectedEndpoint,
  };
}

function canonicalTranscript(value: unknown, budget: ParseBudget): SharedRecording['transcript'] | null {
  if (!isRecord(value) || (value.source !== 'meet-captions' && value.source !== 'stt') || !Array.isArray(value.segments) || value.segments.length > SHARING_CONTRACT_LIMITS.transcriptSegments) return null;
  const segments: NonNullable<SharedRecording['transcript']>['segments'] = [];
  for (const rawSegment of value.segments) {
    if (!isRecord(rawSegment) || !isNonNegativeFiniteNumber(rawSegment.tStartMs)
      || !isNonNegativeFiniteNumber(rawSegment.tEndMs) || rawSegment.tEndMs < rawSegment.tStartMs
      || (rawSegment.speaker != null && (typeof rawSegment.speaker !== 'string' || rawSegment.speaker.length > SHARING_CONTRACT_LIMITS.speakerChars))
      || typeof rawSegment.text !== 'string') return null;
    budget.transcriptTextChars += rawSegment.text.length;
    if (budget.transcriptTextChars > SHARING_CONTRACT_LIMITS.transcriptTextChars) return null;
    segments.push({
      tStartMs: rawSegment.tStartMs,
      tEndMs: rawSegment.tEndMs,
      ...(rawSegment.speaker != null ? { speaker: rawSegment.speaker } : {}),
      text: rawSegment.text,
    });
  }
  return { source: value.source, segments };
}

function canonicalTopics(value: unknown, budget: ParseBudget): NonNullable<SharedRecording['topics']> | null {
  if (!Array.isArray(value) || value.length > SHARING_CONTRACT_LIMITS.topics) return null;
  const topics: NonNullable<SharedRecording['topics']> = [];
  for (const rawTopic of value) {
    if (!isRecord(rawTopic) || !boundedId(rawTopic.id)
      || !Array.isArray(rawTopic.keywords) || rawTopic.keywords.length > SHARING_CONTRACT_LIMITS.topicKeywords
      || !rawTopic.keywords.every((keyword) => typeof keyword === 'string' && keyword.length <= SHARING_CONTRACT_LIMITS.keywordChars)
      || !Array.isArray(rawTopic.spans) || rawTopic.spans.length === 0 || rawTopic.spans.length > SHARING_CONTRACT_LIMITS.topicSpans
      || !isNonNegativeFiniteNumber(rawTopic.totalMs) || !isFiniteNumber(rawTopic.importance)
      || rawTopic.importance < 0 || rawTopic.importance > 1) return null;
    for (const keyword of rawTopic.keywords) {
      budget.topicKeywordTextChars += keyword.length;
      if (budget.topicKeywordTextChars > SHARING_CONTRACT_LIMITS.topicKeywordTextChars) return null;
    }
    budget.topicSpans += rawTopic.spans.length;
    if (budget.topicSpans > SHARING_CONTRACT_LIMITS.topicSpansTotal) return null;

    const spans: NonNullable<SharedRecording['topics']>[number]['spans'] = [];
    for (const rawSpan of rawTopic.spans) {
      if (!isRecord(rawSpan) || !isNonNegativeFiniteNumber(rawSpan.tStartMs)
        || !isNonNegativeFiniteNumber(rawSpan.tEndMs) || rawSpan.tEndMs < rawSpan.tStartMs) return null;
      spans.push({ tStartMs: rawSpan.tStartMs, tEndMs: rawSpan.tEndMs });
    }
    topics.push({
      id: rawTopic.id,
      keywords: [...rawTopic.keywords] as string[],
      spans,
      totalMs: rawTopic.totalMs,
      importance: rawTopic.importance,
    });
  }
  return topics;
}

function canonicalNotations(value: unknown, budget: ParseBudget): NonNullable<SharedRecording['notations']> | null {
  if (!Array.isArray(value) || value.length > SHARING_CONTRACT_LIMITS.notations) return null;
  const notations: NonNullable<SharedRecording['notations']> = [];
  for (const rawNotation of value) {
    if (!isRecord(rawNotation) || !boundedId(rawNotation.id)
      || !isNonNegativeFiniteNumber(rawNotation.tStartMs)
      || typeof rawNotation.text !== 'string' || rawNotation.text.length > SHARING_CONTRACT_LIMITS.notationTextChars
      || (rawNotation.tEndMs != null && (!isNonNegativeFiniteNumber(rawNotation.tEndMs) || rawNotation.tEndMs < rawNotation.tStartMs))
      || (rawNotation.endedBy != null && ((rawNotation.endedBy !== 'user' && rawNotation.endedBy !== 'auto') || rawNotation.tEndMs == null))) return null;
    budget.notationTextChars += rawNotation.text.length;
    if (budget.notationTextChars > SHARING_CONTRACT_LIMITS.notationTextTotalChars) return null;
    notations.push({
      id: rawNotation.id,
      tStartMs: rawNotation.tStartMs,
      ...(rawNotation.tEndMs != null ? { tEndMs: rawNotation.tEndMs } : {}),
      ...(rawNotation.endedBy != null ? { endedBy: rawNotation.endedBy } : {}),
      text: rawNotation.text,
    });
  }
  return notations;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedId(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= SHARING_CONTRACT_LIMITS.idChars;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
