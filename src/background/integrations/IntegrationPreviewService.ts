import type { RecordingNotation } from '../../shared/notations';
import type { RecordingContext } from '../../shared/recordingContext';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import type { Transcript } from '../../shared/transcript';
import { buildIntegrationSnapshotPayload } from '../../integrations/IntegrationSnapshotBuilder';
import type {
  IntegrationDataPolicy,
  IntegrationEventKind,
  IntegrationReadiness,
  IntegrationReadinessPending,
} from '../../integrations/contracts';
import { createIntegrationId } from '../../integrations/ids';
import type { IntegrationPayloadMeasurement } from '../../integrations/payload';
import type { IntegrationPayloadPreview } from '../../integrations/preview';
import { normalizeIntegrationDataPolicy } from '../../integrations/policy';
import type { IntegrationAnalysisProjectionSource } from '../../integrations/IntegrationProjector';
import { extendSpeakerPseudonyms } from '../../integrations/SpeakerPseudonyms';
import type { IntegrationSpeakerAlias } from '../../integrations/persistence';
import type { AnalysisExportState } from '../library/analysis/RecordingAnalysisService';

export const INTEGRATION_PREVIEW_EVENT_TYPE_PREFIX = 'dev.meeting-recorder.preview';

type IntegrationPreviewDeps = {
  getHistory: (recordingId: string) => Promise<RecordingHistoryEntry | undefined>;
  getContext: (recordingId: string) => Promise<RecordingContext | undefined>;
  listNotations: (recordingId: string) => Promise<RecordingNotation[]>;
  getTranscript: (recordingId: string) => Promise<Transcript | undefined>;
  getAnalysisState: (recordingId: string) => Promise<AnalysisExportState>;
  now?: () => number;
};

export type IntegrationSnapshotEnvelope = {
  eventTypePrefix: string;
  eventKind: Extract<IntegrationEventKind, 'recording.ready.v1' | 'recording.updated.v1'>;
  eventId: string;
  eventTime: number;
  producerId: string;
  externalRecordingId: string;
  revision: number;
};

export type BuiltIntegrationSnapshot = IntegrationPayloadMeasurement & {
  readiness: IntegrationReadiness;
  speakerAliases?: IntegrationSpeakerAlias[];
};

/** Reads canonical library aggregates and produces a real serialized fixture without networking. */
export class IntegrationPreviewService {
  private readonly now: () => number;

  constructor(private readonly deps: IntegrationPreviewDeps) {
    this.now = deps.now ?? Date.now;
  }

  async preview(recordingId: string, policy: IntegrationDataPolicy): Promise<IntegrationPayloadPreview> {
    const normalizedPolicy = requirePreviewPolicy(policy);
    const envelope: IntegrationSnapshotEnvelope = {
      eventTypePrefix: INTEGRATION_PREVIEW_EVENT_TYPE_PREFIX,
      eventKind: 'recording.ready.v1',
      eventId: createIntegrationId('event'),
      eventTime: this.now(),
      producerId: createIntegrationId('producer'),
      externalRecordingId: createIntegrationId('recording'),
      revision: 1,
    };
    const built = await this.build(recordingId, normalizedPolicy, envelope);
    return {
      body: built.body,
      eventId: envelope.eventId,
      eventType: `${envelope.eventTypePrefix}.${envelope.eventKind}`,
      externalRecordingId: envelope.externalRecordingId,
      schemaVersion: 'v1',
      revision: envelope.revision,
      readiness: built.readiness,
      totalBytes: built.totalBytes,
      transcriptBytes: built.transcriptBytes,
      otherBytes: built.otherBytes,
      policy: { ...normalizedPolicy },
      syntheticIdentity: true,
    };
  }

  async build(
    recordingId: string,
    policy: IntegrationDataPolicy,
    envelope: IntegrationSnapshotEnvelope,
    currentSpeakerAliases: readonly IntegrationSpeakerAlias[] = [],
  ): Promise<BuiltIntegrationSnapshot> {
    const normalizedPolicy = requirePreviewPolicy(policy);
    const [history, context, notations, transcript, analysisState] = await Promise.all([
      this.deps.getHistory(recordingId),
      this.deps.getContext(recordingId),
      normalizedPolicy.notations ? this.deps.listNotations(recordingId) : Promise.resolve(undefined),
      normalizedPolicy.transcript ? this.deps.getTranscript(recordingId) : Promise.resolve(undefined),
      normalizedPolicy.analysis ? this.deps.getAnalysisState(recordingId) : Promise.resolve(undefined),
    ]);
    if (!history || history.deletedAt) throw new Error('Recording is unavailable');
    if (!context) throw new Error('Recording context is unavailable for this recording');

    const readiness = previewReadiness(normalizedPolicy, history, transcript, analysisState);
    const analysis = analysisProjection(analysisState);
    const pseudonyms = normalizedPolicy.transcript
      && normalizedPolicy.transcriptSpeakers === 'pseudonyms'
      && transcript
      ? await extendSpeakerPseudonyms(transcript, envelope.externalRecordingId, currentSpeakerAliases)
      : undefined;
    const measurement = buildIntegrationSnapshotPayload({
      ...envelope,
      readiness,
      projection: {
        externalRecordingId: envelope.externalRecordingId,
        policy: normalizedPolicy,
        ...(pseudonyms ? { speakerPseudonyms: pseudonyms.bySpeaker } : {}),
        source: {
          history,
          context,
          ...(notations ? { notations } : {}),
          ...(transcript ? { transcript } : {}),
          ...(analysis ? { analysis } : {}),
        },
      },
    });
    return {
      ...measurement,
      readiness,
      ...((pseudonyms?.durable.length || currentSpeakerAliases.length)
        ? { speakerAliases: pseudonyms?.durable ?? [...currentSpeakerAliases] }
        : {}),
    };
  }
}

function previewReadiness(
  policy: IntegrationDataPolicy,
  history: RecordingHistoryEntry,
  transcript: Transcript | undefined,
  analysis: AnalysisExportState | undefined,
) {
  const pending: IntegrationReadinessPending[] = [];
  if (policy.transcript && !transcript) pending.push('transcript');
  if (policy.analysis && (!analysis || analysis.status === 'none' || analysis.status === 'analyzing')) {
    pending.push('analysis');
  }
  if (policy.artifactMetadata && policy.artifactLinks && history.files.some((file) => (
    file.delivery.status === 'pending'
    && !file.locations.some((location) => location.kind === 'drive' && location.webViewLink)
  ))) {
    pending.push('artifact-delivery');
  }
  return {
    complete: pending.length === 0,
    release: pending.length ? 'manual' as const : 'complete' as const,
    pending,
  };
}

function analysisProjection(
  state: AnalysisExportState | undefined,
): IntegrationAnalysisProjectionSource | undefined {
  if (!state || state.status === 'none') return undefined;
  if (state.status === 'stale') return { status: 'unsupported', error: state.error };
  if (state.status === 'completed') return { status: 'completed', result: state.result };
  return {
    status: state.status,
    ...(state.error ? { error: state.error } : {}),
  };
}

function requirePreviewPolicy(policy: IntegrationDataPolicy): IntegrationDataPolicy {
  const normalized = normalizeIntegrationDataPolicy(policy);
  if (!normalized?.metadata) throw new Error('Invalid integration data policy');
  return normalized;
}
