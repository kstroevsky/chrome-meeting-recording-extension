export type PublishedTrack = {
  id: string;
  stream: 'tab' | 'mic' | 'self-video';
  mimeType: string;
  bytes?: number;
  captureStartOffsetMs: number;
  mediaEndpoint: string;
};

type PublishedTranscript = {
  source: 'meet-captions' | 'stt';
  segments: Array<{ tStartMs: number; tEndMs: number; speaker?: string; text: string }>;
};

type PublishedTopic = {
  id: string;
  keywords: string[];
  spans: Array<{ tStartMs: number; tEndMs: number }>;
  totalMs: number;
  importance: number;
};

type PublishedNotation = {
  id: string;
  tStartMs: number;
  tEndMs?: number;
  endedBy?: 'user' | 'auto';
  text: string;
};

export type PublishedRecording = {
  id: string;
  title: string;
  createdAt: number;
  durationMs?: number;
  tracks: PublishedTrack[];
  transcript?: PublishedTranscript;
  topics?: PublishedTopic[];
  notations?: PublishedNotation[];
  downloadsEnabled: boolean;
};

export type PublishedManifest = {
  id: string;
  createdAt: number;
  recordings: PublishedRecording[];
};

export function canonicalizeManifest(value: unknown, expectedShareId: string): PublishedManifest | null {
  if (!isRecord(value) || value.id !== expectedShareId || !isFiniteNumber(value.createdAt)) return null;
  if (!Array.isArray(value.recordings) || value.recordings.length === 0) return null;

  const recordingIds = new Set<string>();
  const recordings: PublishedRecording[] = [];
  for (const rawRecording of value.recordings) {
    const recording = canonicalRecording(rawRecording, recordingIds);
    if (!recording) return null;
    recordings.push(recording);
  }

  return { id: expectedShareId, createdAt: value.createdAt, recordings };
}

export function canonicalizeStoredManifest(manifestJson: string, expectedShareId: string): PublishedManifest | null {
  try {
    return canonicalizeManifest(JSON.parse(manifestJson), expectedShareId);
  } catch {
    return null;
  }
}

function canonicalRecording(value: unknown, recordingIds: Set<string>): PublishedRecording | null {
  if (!isRecord(value) || !isNonEmptyString(value.id) || recordingIds.has(value.id)) return null;
  if (typeof value.title !== 'string' || !isFiniteNumber(value.createdAt)) return null;
  if (value.durationMs != null && !isNonNegativeFiniteNumber(value.durationMs)) return null;
  if (!Array.isArray(value.tracks) || value.tracks.length === 0 || typeof value.downloadsEnabled !== 'boolean') return null;

  recordingIds.add(value.id);
  const trackIds = new Set<string>();
  const tracks: PublishedTrack[] = [];
  for (const rawTrack of value.tracks) {
    const track = canonicalTrack(rawTrack, value.id, trackIds);
    if (!track) return null;
    tracks.push(track);
  }

  const transcript = value.transcript == null ? undefined : canonicalTranscript(value.transcript);
  if (value.transcript != null && !transcript) return null;
  const topics = value.topics == null ? undefined : canonicalTopics(value.topics);
  if (value.topics != null && !topics) return null;
  const notations = value.notations == null ? undefined : canonicalNotations(value.notations);
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

function canonicalTrack(value: unknown, recordingId: string, trackIds: Set<string>): PublishedTrack | null {
  if (!isRecord(value) || !isNonEmptyString(value.id) || trackIds.has(value.id)) return null;
  if (value.stream !== 'tab' && value.stream !== 'mic' && value.stream !== 'self-video') return null;
  if (!isNonEmptyString(value.mimeType) || !isFiniteNumber(value.captureStartOffsetMs)) return null;
  if (value.bytes != null && (!Number.isInteger(value.bytes) || Number(value.bytes) < 0)) return null;

  const expectedEndpoint = `/media/recordings/${encodeURIComponent(recordingId)}/tracks/${encodeURIComponent(value.id)}`;
  if (value.mediaEndpoint !== expectedEndpoint) return null;

  trackIds.add(value.id);
  return {
    id: value.id,
    stream: value.stream,
    mimeType: value.mimeType,
    ...(value.bytes != null ? { bytes: Number(value.bytes) } : {}),
    captureStartOffsetMs: value.captureStartOffsetMs,
    mediaEndpoint: expectedEndpoint,
  };
}

function canonicalTranscript(value: unknown): PublishedTranscript | null {
  if (!isRecord(value) || (value.source !== 'meet-captions' && value.source !== 'stt') || !Array.isArray(value.segments)) return null;
  const segments: PublishedTranscript['segments'] = [];
  for (const rawSegment of value.segments) {
    if (!isRecord(rawSegment) || !isNonNegativeFiniteNumber(rawSegment.tStartMs) ||
        !isNonNegativeFiniteNumber(rawSegment.tEndMs) || rawSegment.tEndMs < rawSegment.tStartMs ||
        (rawSegment.speaker != null && typeof rawSegment.speaker !== 'string') || typeof rawSegment.text !== 'string') {
      return null;
    }
    segments.push({
      tStartMs: rawSegment.tStartMs,
      tEndMs: rawSegment.tEndMs,
      ...(rawSegment.speaker != null ? { speaker: rawSegment.speaker } : {}),
      text: rawSegment.text,
    });
  }
  return { source: value.source, segments };
}

function canonicalTopics(value: unknown): PublishedTopic[] | null {
  if (!Array.isArray(value)) return null;
  const topics: PublishedTopic[] = [];
  for (const rawTopic of value) {
    if (!isRecord(rawTopic) || !isNonEmptyString(rawTopic.id) ||
        !Array.isArray(rawTopic.keywords) || !rawTopic.keywords.every((keyword) => typeof keyword === 'string') ||
        !Array.isArray(rawTopic.spans) || rawTopic.spans.length === 0 ||
        !isNonNegativeFiniteNumber(rawTopic.totalMs) || !isFiniteNumber(rawTopic.importance) ||
        rawTopic.importance < 0 || rawTopic.importance > 1) {
      return null;
    }
    const spans: PublishedTopic['spans'] = [];
    for (const rawSpan of rawTopic.spans) {
      if (!isRecord(rawSpan) || !isNonNegativeFiniteNumber(rawSpan.tStartMs) ||
          !isNonNegativeFiniteNumber(rawSpan.tEndMs) || rawSpan.tEndMs < rawSpan.tStartMs) {
        return null;
      }
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

function canonicalNotations(value: unknown): PublishedNotation[] | null {
  if (!Array.isArray(value)) return null;
  const notations: PublishedNotation[] = [];
  for (const rawNotation of value) {
    if (!isRecord(rawNotation) || !isNonEmptyString(rawNotation.id) ||
        !isNonNegativeFiniteNumber(rawNotation.tStartMs) || typeof rawNotation.text !== 'string' ||
        (rawNotation.tEndMs != null && (!isNonNegativeFiniteNumber(rawNotation.tEndMs) || rawNotation.tEndMs < rawNotation.tStartMs)) ||
        (rawNotation.endedBy != null && ((rawNotation.endedBy !== 'user' && rawNotation.endedBy !== 'auto') || rawNotation.tEndMs == null))) {
      return null;
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
