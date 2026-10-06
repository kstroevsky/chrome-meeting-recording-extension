import type { IntegrationDataPolicy } from '../../../integrations/contracts';
import { INTEGRATION_EVENT_TYPE_PREFIX } from '../../../integrations/config';
import type { RecordingHistoryEntry } from '../../../shared/recordingHistory';
import type { Transcript } from '../../../shared/transcript';
import {
  TRANSCRIPT_CANONICALIZATION_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptSnapshot,
} from '../../../shared/transcriptIdentity';
import { utf8ByteLength } from '../../../integrations/serialization';
import { IntegrationPreviewService } from '../IntegrationPreviewService';

const POLICY: IntegrationDataPolicy = {
  metadata: true,
  meetingIdentity: false,
  userNote: true,
  notations: true,
  transcript: true,
  analysis: false,
  artifactMetadata: true,
  artifactLinks: false,
  transcriptSpeakers: 'pseudonyms',
};

function history(): RecordingHistoryEntry {
  return {
    id: 'recording:internal-secret',
    name: 'Therapy session',
    note: 'Follow up next week',
    createdAt: 1_000,
    durationMs: 12_000,
    storageMode: 'local',
    status: 'complete',
    files: [{
      id: 'recording:internal-secret:tab',
      stream: 'tab',
      filename: 'private-filename.webm',
      mimeType: 'video/webm',
      locations: [{ kind: 'opfs', key: 'private-opfs-key', retainedAt: 2_000 }],
      delivery: { requested: 'local', status: 'downloaded' },
      destination: 'local',
      status: 'available',
    }],
  };
}

function transcriptSnapshot(
  transcript: Transcript,
  revision = 1,
  contentHash = `transcript-hash-${revision}`,
): TranscriptSnapshot {
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
    generation: `transcript-generation-${revision}`,
    revision,
    contentHash,
    committedAt: 1_000 + revision,
    transcript,
  };
}

describe('IntegrationPreviewService', () => {
  it('builds the receiver fixture through the production serializer without leaking local ids', async () => {
    const service = new IntegrationPreviewService({
      getHistory: async () => history(),
      getContext: async () => ({
        recordingId: 'recording:internal-secret',
        startedAt: 10_000,
        endedAt: 22_000,
        source: { kind: 'meeting', provider: 'google-meet', meetingId: 'secret-meeting' },
      }),
      listNotations: async () => [{ id: 'notation:private', tStartMs: 2_000, text: 'Important' }],
      getTranscriptSnapshot: async () => transcriptSnapshot({
        source: 'meet-captions',
        segments: [
          { tStartMs: 0, tEndMs: 1_000, speaker: 'Alice Private', text: 'Hello' },
          { tStartMs: 2_000, tEndMs: 3_000, speaker: 'Bob Private', text: 'Hi' },
        ],
      }),
      getAnalysisState: async () => ({ status: 'none' }),
      now: () => 30_000,
    });

    const preview = await service.preview('recording:internal-secret', POLICY);
    const event = JSON.parse(preview.body);

    expect(preview.totalBytes).toBe(utf8ByteLength(preview.body));
    expect(preview.readiness).toEqual({ complete: true, release: 'complete', pending: [] });
    expect(event.data.recording.id).toBe(preview.externalRecordingId);
    expect(event.data.recording.transcript.segments.map((segment: { speaker?: string }) => segment.speaker))
      .toEqual(['Speaker 1', 'Speaker 2']);
    expect(event.data.recording.source).toEqual({ kind: 'meeting' });
    expect(preview.body).not.toContain('recording:internal-secret');
    expect(preview.body).not.toContain('notation:private');
    expect(preview.body).not.toContain('private-filename.webm');
    expect(preview.body).not.toContain('private-opfs-key');
    expect(preview.body).not.toContain('Alice Private');
    expect(preview.body).not.toContain('Bob Private');
    expect(preview.body).not.toContain('secret-meeting');
  });

  it('keeps destination-scoped speaker aliases stable when a later revision backfills a speaker', async () => {
    let transcript = {
      source: 'meet-captions' as const,
      segments: [
        { tStartMs: 1_000, tEndMs: 2_000, speaker: 'Alice Private', text: 'Hello' },
        { tStartMs: 2_000, tEndMs: 3_000, speaker: 'Bob Private', text: 'Hi' },
      ],
    };
    const service = new IntegrationPreviewService({
      getHistory: async () => history(),
      getContext: async () => ({
        recordingId: 'recording:internal-secret',
        startedAt: 10_000,
        source: { kind: 'meeting' },
      }),
      listNotations: async () => [],
      getTranscriptSnapshot: async () => transcriptSnapshot(transcript),
      getAnalysisState: async () => ({ status: 'none' }),
    });
    const first = await service.build('recording:internal-secret', POLICY, {
      eventTypePrefix: INTEGRATION_EVENT_TYPE_PREFIX,
      eventKind: 'recording.ready.v1',
      eventId: 'event_1',
      eventTime: 20_000,
      producerId: 'producer_1',
      externalRecordingId: 'recording_external_stable',
      revision: 1,
    });

    transcript = {
      ...transcript,
      segments: [
        { tStartMs: 0, tEndMs: 900, speaker: 'Carol Private', text: 'Earlier speaker' },
        ...transcript.segments,
      ],
    };
    const second = await service.build('recording:internal-secret', POLICY, {
      eventTypePrefix: INTEGRATION_EVENT_TYPE_PREFIX,
      eventKind: 'recording.updated.v1',
      eventId: 'event_2',
      eventTime: 21_000,
      producerId: 'producer_1',
      externalRecordingId: 'recording_external_stable',
      revision: 2,
    }, first.speakerAliases);

    expect(JSON.parse(first.body).data.recording.transcript.segments.map(
      (segment: { speaker?: string }) => segment.speaker,
    )).toEqual(['Speaker 1', 'Speaker 2']);
    expect(JSON.parse(second.body).data.recording.transcript.segments.map(
      (segment: { speaker?: string }) => segment.speaker,
    )).toEqual(['Speaker 3', 'Speaker 1', 'Speaker 2']);
    expect(second.speakerAliases).toHaveLength(3);
    const persistedAliases = JSON.stringify(second.speakerAliases);
    expect(persistedAliases).not.toContain('Alice Private');
    expect(persistedAliases).not.toContain('Bob Private');
    expect(persistedAliases).not.toContain('Carol Private');
  });

  it('marks explicitly selected but unavailable data as a manual partial fixture', async () => {
    const service = new IntegrationPreviewService({
      getHistory: async () => history(),
      getContext: async () => ({
        recordingId: 'recording:internal-secret',
        startedAt: 10_000,
        source: { kind: 'tab' },
      }),
      listNotations: async () => [],
      getTranscriptSnapshot: async () => undefined,
      getAnalysisState: async () => ({ status: 'none' }),
      now: () => 30_000,
    });

    const preview = await service.preview('recording:internal-secret', {
      ...POLICY,
      transcript: true,
      analysis: true,
      artifactMetadata: false,
    });

    expect(preview.readiness).toEqual({
      complete: false,
      release: 'manual',
      pending: ['analysis'],
    });
    expect(JSON.parse(preview.body).data.recording).not.toHaveProperty('transcript');
    expect(JSON.parse(preview.body).data.recording).not.toHaveProperty('analysis');
  });

  it('rejects legacy recordings that have no durable occurrence context', async () => {
    const service = new IntegrationPreviewService({
      getHistory: async () => history(),
      getContext: async () => undefined,
      listNotations: async () => [],
      getTranscriptSnapshot: async () => undefined,
      getAnalysisState: async () => ({ status: 'none' }),
    });

    await expect(service.preview('recording:internal-secret', POLICY))
      .rejects.toThrow('Recording context is unavailable');
  });

  it('projects terminal analysis failure without leaving readiness pending', async () => {
    const service = new IntegrationPreviewService({
      getHistory: async () => history(),
      getContext: async () => ({
        recordingId: 'recording:internal-secret',
        startedAt: 10_000,
        source: { kind: 'tab' },
      }),
      listNotations: async () => [],
      getTranscriptSnapshot: async () => undefined,
      getAnalysisState: async () => ({ status: 'failed', error: 'analysis backend unavailable' }),
      now: () => 30_000,
    });

    const preview = await service.preview('recording:internal-secret', {
      ...POLICY,
      transcript: false,
      analysis: true,
      artifactMetadata: false,
    });

    expect(preview.readiness).toEqual({ complete: true, release: 'complete', pending: [] });
    expect(JSON.parse(preview.body).data.recording.analysis).toEqual({
      status: 'failed',
      error: 'analysis backend unavailable',
    });
  });

  it('keeps stale analysis pending and omits it from the snapshot', async () => {
    const service = new IntegrationPreviewService({
      getHistory: async () => history(),
      getContext: async () => ({
        recordingId: 'recording:internal-secret',
        startedAt: 10_000,
        source: { kind: 'tab' },
      }),
      listNotations: async () => [],
      getTranscriptSnapshot: async () => undefined,
      getAnalysisState: async () => ({ status: 'stale', error: 'Stored analysis is stale.' }),
      now: () => 30_000,
    });

    const preview = await service.preview('recording:internal-secret', {
      ...POLICY,
      transcript: false,
      analysis: true,
      artifactMetadata: false,
    });

    expect(preview.readiness.pending).toEqual(['analysis']);
    expect(JSON.parse(preview.body).data.recording).not.toHaveProperty('analysis');
  });

  it('never combines a transcript with completed analysis from another transcript hash', async () => {
    const transcript = {
      source: 'meet-captions' as const,
      segments: [{ tStartMs: 0, tEndMs: 1_000, speaker: 'Ada', text: 'revision B' }],
    };
    const service = new IntegrationPreviewService({
      getHistory: async () => history(),
      getContext: async () => ({
        recordingId: 'recording:internal-secret',
        startedAt: 10_000,
        source: { kind: 'tab' },
      }),
      listNotations: async () => [],
      getTranscriptSnapshot: async () => transcriptSnapshot(transcript, 2, 'hash-of-revision-b'),
      getAnalysisState: async () => ({
        status: 'completed',
        result: {
          provenance: {
            transcriptGeneration: 'transcript-generation-1',
            transcriptRevision: 1,
            transcriptHash: 'hash-of-revision-a',
            pipelineVersion: 2,
            embeddingModel: 'test-model',
            embeddingModelRevision: 'test-revision',
            embeddingDimensions: 2,
            embeddingDtype: 'q8',
            configHash: 'test-config',
          },
          segments: [],
          topics: [],
          utteranceCount: 0,
          completedAt: 20_000,
        },
      }),
      now: () => 30_000,
    });

    const preview = await service.preview('recording:internal-secret', {
      ...POLICY,
      transcript: true,
      analysis: true,
      artifactMetadata: false,
    });
    const projected = JSON.parse(preview.body).data.recording;

    expect(preview.readiness.pending).toEqual(['analysis']);
    expect(projected.transcript.segments).toHaveLength(1);
    expect(projected).not.toHaveProperty('analysis');
  });

  it('keeps completed analysis when analysis is exported without transcript content', async () => {
    const transcript = {
      source: 'meet-captions' as const,
      segments: [{ tStartMs: 0, tEndMs: 1_000, speaker: 'Ada', text: 'current transcript' }],
    };
    const service = new IntegrationPreviewService({
      getHistory: async () => history(),
      getContext: async () => ({
        recordingId: 'recording:internal-secret',
        startedAt: 10_000,
        source: { kind: 'tab' },
      }),
      listNotations: async () => [],
      getTranscriptSnapshot: async () => transcriptSnapshot(transcript, 3, 'hash-current'),
      getAnalysisState: async () => ({
        status: 'completed',
        result: {
          provenance: {
            transcriptGeneration: 'transcript-generation-3',
            transcriptRevision: 3,
            transcriptHash: 'hash-current',
            pipelineVersion: 2,
            embeddingModel: 'test-model',
            embeddingModelRevision: 'test-revision',
            embeddingDimensions: 2,
            embeddingDtype: 'q8',
            configHash: 'test-config',
          },
          segments: [],
          topics: [],
          utteranceCount: 0,
          completedAt: 20_000,
        },
      }),
      now: () => 30_000,
    });

    const preview = await service.preview('recording:internal-secret', {
      ...POLICY,
      transcript: false,
      analysis: true,
      artifactMetadata: false,
    });
    const projected = JSON.parse(preview.body).data.recording;

    expect(preview.readiness.pending).toEqual([]);
    expect(projected).not.toHaveProperty('transcript');
    expect(projected.analysis.status).toBe('completed');
  });

  it('rejects completed analysis from another revision even when the content hash matches', async () => {
    const transcript = {
      source: 'meet-captions' as const,
      segments: [{ tStartMs: 0, tEndMs: 1_000, text: 'same content after replacement' }],
    };
    const service = new IntegrationPreviewService({
      getHistory: async () => history(),
      getContext: async () => ({
        recordingId: 'recording:internal-secret',
        startedAt: 10_000,
        source: { kind: 'tab' },
      }),
      listNotations: async () => [],
      getTranscriptSnapshot: async () => transcriptSnapshot(transcript, 4, 'same-hash'),
      getAnalysisState: async () => ({
        status: 'completed',
        result: {
          provenance: {
            transcriptGeneration: 'transcript-generation-2',
            transcriptRevision: 2,
            transcriptHash: 'same-hash',
            pipelineVersion: 2,
            embeddingModel: 'test-model',
            embeddingModelRevision: 'test-revision',
            embeddingDimensions: 2,
            embeddingDtype: 'q8',
            configHash: 'test-config',
          },
          segments: [],
          topics: [],
          utteranceCount: 0,
          completedAt: 20_000,
        },
      }),
    });

    const preview = await service.preview('recording:internal-secret', {
      ...POLICY,
      transcript: true,
      analysis: true,
      artifactMetadata: false,
    });

    expect(preview.readiness.pending).toEqual(['analysis']);
    expect(JSON.parse(preview.body).data.recording).not.toHaveProperty('analysis');
  });
});
