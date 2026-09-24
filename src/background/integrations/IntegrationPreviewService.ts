import type { StoredAnalysis } from '../../shared/analysis/storedAnalysis';
import type { RecordingNotation } from '../../shared/notations';
import type { RecordingContext } from '../../shared/recordingContext';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import type { Transcript } from '../../shared/transcript';
import { buildIntegrationSnapshotPayload } from '../../integrations/IntegrationSnapshotBuilder';
import type { IntegrationDataPolicy, IntegrationReadinessPending } from '../../integrations/contracts';
import { createIntegrationId } from '../../integrations/ids';
import type { IntegrationPayloadPreview } from '../../integrations/preview';

export const INTEGRATION_PREVIEW_EVENT_TYPE_PREFIX = 'dev.meeting-recorder.preview';

type IntegrationPreviewDeps = {
  getHistory: (recordingId: string) => Promise<RecordingHistoryEntry | undefined>;
  getContext: (recordingId: string) => Promise<RecordingContext | undefined>;
  listNotations: (recordingId: string) => Promise<RecordingNotation[]>;
  getTranscript: (recordingId: string) => Promise<Transcript | undefined>;
  getAnalysis: (recordingId: string) => Promise<StoredAnalysis | undefined>;
  now?: () => number;
};

/** Reads canonical library aggregates and produces a real serialized fixture without networking. */
export class IntegrationPreviewService {
  private readonly now: () => number;

  constructor(private readonly deps: IntegrationPreviewDeps) {
    this.now = deps.now ?? Date.now;
  }

  async preview(recordingId: string, policy: IntegrationDataPolicy): Promise<IntegrationPayloadPreview> {
    assertPreviewPolicy(policy);
    const [history, context, notations, transcript, analysis] = await Promise.all([
      this.deps.getHistory(recordingId),
      this.deps.getContext(recordingId),
      policy.notations ? this.deps.listNotations(recordingId) : Promise.resolve(undefined),
      policy.transcript ? this.deps.getTranscript(recordingId) : Promise.resolve(undefined),
      policy.analysis ? this.deps.getAnalysis(recordingId) : Promise.resolve(undefined),
    ]);
    if (!history || history.deletedAt) throw new Error('Recording is unavailable');
    if (!context) throw new Error('Recording context is unavailable for this recording');

    const externalRecordingId = createIntegrationId('recording');
    const eventId = createIntegrationId('event');
    const producerId = createIntegrationId('producer');
    const readiness = previewReadiness(policy, history, transcript, analysis);
    const measurement = buildIntegrationSnapshotPayload({
      eventTypePrefix: INTEGRATION_PREVIEW_EVENT_TYPE_PREFIX,
      eventKind: 'recording.ready.v1',
      eventId,
      eventTime: this.now(),
      producerId,
      externalRecordingId,
      revision: 1,
      readiness,
      projection: {
        externalRecordingId,
        policy,
        source: {
          history,
          context,
          ...(notations ? { notations } : {}),
          ...(transcript ? { transcript } : {}),
          ...(analysis ? { analysis: { status: 'completed', result: analysis } } : {}),
        },
      },
    });

    return {
      body: measurement.body,
      eventId,
      eventType: `${INTEGRATION_PREVIEW_EVENT_TYPE_PREFIX}.recording.ready.v1`,
      externalRecordingId,
      schemaVersion: 'v1',
      revision: 1,
      readiness,
      totalBytes: measurement.totalBytes,
      transcriptBytes: measurement.transcriptBytes,
      otherBytes: measurement.otherBytes,
      policy: { ...policy },
      syntheticIdentity: true,
    };
  }
}

function previewReadiness(
  policy: IntegrationDataPolicy,
  history: RecordingHistoryEntry,
  transcript: Transcript | undefined,
  analysis: StoredAnalysis | undefined,
) {
  const pending: IntegrationReadinessPending[] = [];
  if (policy.transcript && !transcript) pending.push('transcript');
  if (policy.analysis && !analysis) pending.push('analysis');
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

function assertPreviewPolicy(policy: IntegrationDataPolicy): void {
  const booleanKeys = [
    'metadata',
    'meetingIdentity',
    'userNote',
    'notations',
    'transcript',
    'analysis',
    'artifactMetadata',
    'artifactLinks',
  ] as const;
  if (booleanKeys.some((key) => typeof policy[key] !== 'boolean')) {
    throw new Error('Invalid integration data policy');
  }
  if (!['names', 'pseudonyms', 'omit'].includes(policy.transcriptSpeakers)) {
    throw new Error('Invalid transcript speaker policy');
  }
}
