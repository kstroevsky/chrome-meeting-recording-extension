import type { IntegrationDataPolicy } from '../../../integrations/contracts';
import type { RecordingHistoryEntry } from '../../../shared/recordingHistory';
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
      getTranscript: async () => ({
        source: 'meet-captions',
        segments: [
          { tStartMs: 0, tEndMs: 1_000, speaker: 'Alice Private', text: 'Hello' },
          { tStartMs: 2_000, tEndMs: 3_000, speaker: 'Bob Private', text: 'Hi' },
        ],
      }),
      getAnalysis: async () => undefined,
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

  it('marks explicitly selected but unavailable data as a manual partial fixture', async () => {
    const service = new IntegrationPreviewService({
      getHistory: async () => history(),
      getContext: async () => ({
        recordingId: 'recording:internal-secret',
        startedAt: 10_000,
        source: { kind: 'tab' },
      }),
      listNotations: async () => [],
      getTranscript: async () => undefined,
      getAnalysis: async () => undefined,
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
      pending: ['transcript', 'analysis'],
    });
    expect(JSON.parse(preview.body).data.recording).not.toHaveProperty('transcript');
    expect(JSON.parse(preview.body).data.recording).not.toHaveProperty('analysis');
  });

  it('rejects legacy recordings that have no durable occurrence context', async () => {
    const service = new IntegrationPreviewService({
      getHistory: async () => history(),
      getContext: async () => undefined,
      listNotations: async () => [],
      getTranscript: async () => undefined,
      getAnalysis: async () => undefined,
    });

    await expect(service.preview('recording:internal-secret', POLICY))
      .rejects.toThrow('Recording context is unavailable');
  });
});
