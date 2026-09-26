import type { RecordingNotation } from '../../shared/notations';
import type { RecordingContext } from '../../shared/recordingContext';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import type { TranscriptSnapshot } from '../../shared/transcriptIdentity';
import { buildIntegrationSnapshotPayload } from '../../integrations/IntegrationSnapshotBuilder';
import type {
  IntegrationDataPolicy,
  IntegrationEventKind,
  IntegrationReadiness,
  IntegrationReadinessEvaluation,
} from '../../integrations/contracts';
import { IntegrationReadinessEvaluator } from '../../integrations/IntegrationReadinessEvaluator';
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
  getTranscriptSnapshot: (recordingId: string) => Promise<TranscriptSnapshot | undefined>;
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
  private readonly readinessEvaluator = new IntegrationReadinessEvaluator();

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
    incompleteRelease: Extract<IntegrationReadiness['release'], 'manual' | 'timeout'> = 'manual',
  ): Promise<BuiltIntegrationSnapshot> {
    const normalizedPolicy = requirePreviewPolicy(policy);
    const [history, context, notations, transcriptSnapshot, rawAnalysisState] = await Promise.all([
      this.deps.getHistory(recordingId),
      this.deps.getContext(recordingId),
      normalizedPolicy.notations ? this.deps.listNotations(recordingId) : Promise.resolve(undefined),
      normalizedPolicy.transcript || normalizedPolicy.analysis
        ? this.deps.getTranscriptSnapshot(recordingId)
        : Promise.resolve(undefined),
      normalizedPolicy.analysis ? this.deps.getAnalysisState(recordingId) : Promise.resolve(undefined),
    ]);
    if (!history || history.deletedAt) throw new Error('Recording is unavailable');
    if (!context) throw new Error('Recording context is unavailable for this recording');

    const transcript = normalizedPolicy.transcript ? transcriptSnapshot?.transcript : undefined;
    const analysisState = alignAnalysisWithTranscript(rawAnalysisState, transcriptSnapshot);
    const readinessEvaluation = this.readinessEvaluator.evaluate({
      history,
      ...(transcript ? { transcript } : {}),
      ...(analysisState ? { analysis: analysisState } : {}),
    }, normalizedPolicy);
    const readiness: IntegrationReadiness = {
      ...readinessEvaluation,
      release: readinessEvaluation.complete ? 'complete' : incompleteRelease,
    };
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

  async evaluateReadiness(
    recordingId: string,
    policy: IntegrationDataPolicy,
  ): Promise<IntegrationReadinessEvaluation> {
    const normalizedPolicy = requirePreviewPolicy(policy);
    // A transcript is never waited for; it is read only to tell whether the
    // analysis still belongs to it (a stale one is re-run, so it is pending).
    const [history, transcriptSnapshot, rawAnalysisState] = await Promise.all([
      this.deps.getHistory(recordingId),
      normalizedPolicy.analysis ? this.deps.getTranscriptSnapshot(recordingId) : Promise.resolve(undefined),
      normalizedPolicy.analysis ? this.deps.getAnalysisState(recordingId) : Promise.resolve(undefined),
    ]);
    if (!history || history.deletedAt) throw new Error('Recording is unavailable');
    const analysisState = alignAnalysisWithTranscript(rawAnalysisState, transcriptSnapshot);
    return this.readinessEvaluator.evaluate({
      history,
      ...(analysisState ? { analysis: analysisState } : {}),
    }, normalizedPolicy);
  }
}

function analysisProjection(
  state: AnalysisExportState | undefined,
): IntegrationAnalysisProjectionSource | undefined {
  if (!state || state.status === 'none') return undefined;
  if (state.status === 'stale') return undefined;
  if (state.status === 'completed') return { status: 'completed', result: state.result };
  return {
    status: state.status,
    ...(state.error ? { error: state.error } : {}),
  };
}

function alignAnalysisWithTranscript(
  state: AnalysisExportState | undefined,
  transcript: TranscriptSnapshot | undefined,
): AnalysisExportState | undefined {
  if (!state || state.status !== 'completed') return state;
  if (!transcript) {
    return { status: 'stale', error: 'Analysis does not match the transcript selected for this snapshot.' };
  }
  if (
    state.result.provenance.transcriptRevision === transcript.revision
    && state.result.provenance.transcriptHash === transcript.contentHash
  ) return state;
  return { status: 'stale', error: 'Analysis does not match the transcript selected for this snapshot.' };
}

function requirePreviewPolicy(policy: IntegrationDataPolicy): IntegrationDataPolicy {
  const normalized = normalizeIntegrationDataPolicy(policy);
  if (!normalized?.metadata) throw new Error('Invalid integration data policy');
  return normalized;
}
