import type { AnalysisJobStatus } from '../shared/analysis/job';
import type { StoredAnalysis } from '../shared/analysis/storedAnalysis';
import type { RecordingNotation } from '../shared/notations';
import type { RecordingContext } from '../shared/recordingContext';
import type { RecordingHistoryEntry, RecordingHistoryFile } from '../shared/recordingHistory';
import type { Transcript } from '../shared/transcript';
import type { IntegrationDataPolicy, IntegrationRecordingV1 } from './contracts';

export type IntegrationAnalysisProjectionSource = {
  status: AnalysisJobStatus;
  error?: string;
  result?: Pick<StoredAnalysis, 'segments' | 'topics'>;
};

export type IntegrationProjectionSource = {
  history: RecordingHistoryEntry;
  context: RecordingContext;
  notations?: RecordingNotation[];
  transcript?: Transcript;
  analysis?: IntegrationAnalysisProjectionSource;
};

export type IntegrationProjectionInput = {
  externalRecordingId: string;
  policy: IntegrationDataPolicy;
  source: IntegrationProjectionSource;
};

/**
 * Builds the receiver-facing snapshot. Internal durable identifiers are never
 * copied into the returned object.
 */
export function projectIntegrationRecording(
  input: IntegrationProjectionInput,
): IntegrationRecordingV1 {
  if (!input.policy.metadata) {
    throw new Error('Recording metadata must be enabled for an integration snapshot');
  }

  const { history, context } = input.source;
  const result: IntegrationRecordingV1 = {
    id: input.externalRecordingId,
    title: history.name,
    startedAt: toIso(context.startedAt),
    ...(context.endedAt != null ? { endedAt: toIso(context.endedAt) } : {}),
    ...(history.durationMs != null ? { durationMs: history.durationMs } : {}),
    source: {
      kind: context.source.kind,
      ...(input.policy.meetingIdentity && context.source.provider
        ? { provider: context.source.provider }
        : {}),
      ...(input.policy.meetingIdentity && context.source.meetingId
        ? { meetingId: context.source.meetingId }
        : {}),
      ...(input.policy.meetingIdentity && context.source.meetingUrl
        ? { meetingUrl: context.source.meetingUrl }
        : {}),
    },
  };

  if (input.policy.userNote && history.note) result.note = history.note;
  if (input.policy.notations && input.source.notations?.length) {
    result.notations = [...input.source.notations]
      .sort((a, b) => a.tStartMs - b.tStartMs || a.text.localeCompare(b.text))
      .map((notation) => ({
        tStartMs: notation.tStartMs,
        ...(notation.tEndMs != null ? { tEndMs: notation.tEndMs } : {}),
        text: notation.text,
      }));
  }
  if (input.policy.transcript && input.source.transcript) {
    result.transcript = projectTranscript(input.source.transcript, input.policy);
  }
  if (input.policy.analysis && input.source.analysis) {
    result.analysis = projectAnalysis(input.source.analysis);
  }
  if (input.policy.artifactMetadata && history.files.length) {
    result.artifacts = history.files
      .map((file) => projectArtifact(file, input.policy.artifactLinks))
      .sort((a, b) =>
        a.type.localeCompare(b.type)
        || a.mimeType.localeCompare(b.mimeType)
        || (a.bytes ?? -1) - (b.bytes ?? -1));
  }
  return result;
}

function projectTranscript(
  transcript: Transcript,
  policy: IntegrationDataPolicy,
): NonNullable<IntegrationRecordingV1['transcript']> {
  const pseudonyms = new Map<string, string>();
  let nextPseudonym = 1;
  return {
    source: transcript.source,
    segments: transcript.segments.map((segment) => {
      let speaker: string | undefined;
      if (segment.speaker && policy.transcriptSpeakers === 'names') {
        speaker = segment.speaker;
      } else if (segment.speaker && policy.transcriptSpeakers === 'pseudonyms') {
        speaker = pseudonyms.get(segment.speaker);
        if (!speaker) {
          speaker = `Speaker ${nextPseudonym++}`;
          pseudonyms.set(segment.speaker, speaker);
        }
      }
      return {
        tStartMs: segment.tStartMs,
        tEndMs: segment.tEndMs,
        ...(speaker ? { speaker } : {}),
        text: segment.text,
      };
    }),
  };
}

function projectAnalysis(
  analysis: IntegrationAnalysisProjectionSource,
): NonNullable<IntegrationRecordingV1['analysis']> {
  const projected: NonNullable<IntegrationRecordingV1['analysis']> = {
    status: analysis.status,
    ...(analysis.error ? { error: analysis.error } : {}),
  };
  if (analysis.status !== 'completed' || !analysis.result) return projected;

  const segmentById = new Map(analysis.result.segments.map((segment) => [segment.id, segment]));
  projected.topics = [...analysis.result.topics]
    .sort((a, b) =>
      b.importance - a.importance
      || a.keywords.join('\u0000').localeCompare(b.keywords.join('\u0000')))
    .map((topic) => ({
      keywords: [...topic.keywords],
      importance: topic.importance,
      spans: topic.segments
        .map((segmentId) => segmentById.get(segmentId))
        .filter((segment): segment is StoredAnalysis['segments'][number] => segment != null)
        .map((segment) => ({ tStartMs: segment.tStartMs, tEndMs: segment.tEndMs }))
        .sort((a, b) => a.tStartMs - b.tStartMs || a.tEndMs - b.tEndMs),
    }));
  return projected;
}

function projectArtifact(
  file: RecordingHistoryFile,
  includeLink: boolean,
): NonNullable<IntegrationRecordingV1['artifacts']>[number] {
  const type = file.kind === 'notes' ? 'notes'
    : file.kind === 'transcript' ? 'transcript'
    : file.stream === 'mic' ? 'microphone-recording'
    : file.stream === 'self-video' ? 'self-video'
    : 'tab-recording';
  const driveLink = file.locations.find((location) => location.kind === 'drive')?.webViewLink;
  return {
    type,
    mimeType: file.mimeType,
    ...(file.bytes != null ? { bytes: file.bytes } : {}),
    delivery: file.delivery.status,
    ...(includeLink && driveLink ? { viewUrl: driveLink } : {}),
  };
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
