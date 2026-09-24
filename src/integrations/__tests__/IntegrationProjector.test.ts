import type { StoredAnalysis } from '../../shared/analysis/storedAnalysis';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import type { IntegrationDataPolicy } from '../contracts';
import { projectIntegrationRecording } from '../IntegrationProjector';

const POLICY: IntegrationDataPolicy = {
  metadata: true,
  meetingIdentity: true,
  userNote: true,
  notations: true,
  transcript: true,
  analysis: true,
  artifactMetadata: true,
  artifactLinks: true,
  transcriptSpeakers: 'pseudonyms',
};

const HISTORY: RecordingHistoryEntry = {
  id: 'recording:internal-secret',
  name: 'Hiring sync',
  note: 'Follow up tomorrow',
  durationMs: 12_000,
  createdAt: 999,
  storageMode: 'drive',
  status: 'complete',
  files: [{
    id: 'recording:internal-secret:tab',
    stream: 'tab',
    filename: 'private-filename.webm',
    mimeType: 'video/webm',
    locations: [{ kind: 'drive', fileId: 'drive-secret-id', webViewLink: 'https://drive.example/view' }],
    delivery: { requested: 'drive', status: 'uploaded' },
    destination: 'drive',
    status: 'available',
    bytes: 456,
    driveFileId: 'drive-secret-id',
    webViewLink: 'https://drive.example/view',
  }],
};

const ANALYSIS: Pick<StoredAnalysis, 'segments' | 'topics'> = {
  segments: [
    {
      id: 'segment:private-1',
      tStartMs: 100,
      tEndMs: 500,
      embedding: new Float32Array([1]),
      localTopicId: 'topic:private-1',
      startWindow: 0,
      endWindow: 1,
    },
  ],
  topics: [{
    id: 'topic:private-1',
    centroid: new Float32Array([1]),
    segments: ['segment:private-1'],
    keywords: ['hiring', 'timeline'],
    importance: 0.9,
  }],
};

function source() {
  return {
    history: HISTORY,
    context: {
      recordingId: HISTORY.id,
      startedAt: Date.UTC(2026, 8, 24, 15, 0, 0),
      endedAt: Date.UTC(2026, 8, 24, 15, 12, 0),
      source: {
        kind: 'meeting' as const,
        provider: 'google-meet',
        meetingId: 'abc-defg-hij',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      },
    },
    notations: [{
      id: 'notation:private-id',
      tStartMs: 1_000,
      tEndMs: 1_500,
      endedBy: 'user' as const,
      text: 'Decision',
    }],
    transcript: {
      source: 'meet-captions' as const,
      segments: [
        { tStartMs: 10, tEndMs: 50, speaker: 'Alice', text: 'Hello' },
        { tStartMs: 60, tEndMs: 90, speaker: 'Bob', text: 'Hi' },
        { tStartMs: 100, tEndMs: 130, speaker: 'Alice', text: 'Next' },
      ],
    },
    analysis: {
      status: 'completed' as const,
      result: ANALYSIS,
    },
  };
}

describe('projectIntegrationRecording', () => {
  it('exports destination-scoped state without internal storage identifiers', () => {
    const projected = projectIntegrationRecording({
      externalRecordingId: 'recording_external_123',
      policy: POLICY,
      source: source(),
    });

    expect(projected).toEqual(expect.objectContaining({
      id: 'recording_external_123',
      title: 'Hiring sync',
      startedAt: '2026-09-24T15:00:00.000Z',
      endedAt: '2026-09-24T15:12:00.000Z',
      note: 'Follow up tomorrow',
      source: {
        kind: 'meeting',
        provider: 'google-meet',
        meetingId: 'abc-defg-hij',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      },
    }));
    expect(projected.notations).toEqual([
      { tStartMs: 1_000, tEndMs: 1_500, text: 'Decision' },
    ]);
    expect(projected.transcript?.segments.map((segment) => segment.speaker)).toEqual([
      'Speaker 1',
      'Speaker 2',
      'Speaker 1',
    ]);
    expect(JSON.stringify(projected.transcript)).not.toContain('Alice');
    expect(JSON.stringify(projected.transcript)).not.toContain('Bob');
    expect(projected.analysis?.topics).toEqual([{
      keywords: ['hiring', 'timeline'],
      importance: 0.9,
      spans: [{ tStartMs: 100, tEndMs: 500 }],
    }]);
    expect(projected.artifacts).toEqual([{
      type: 'tab-recording',
      mimeType: 'video/webm',
      bytes: 456,
      delivery: 'uploaded',
      viewUrl: 'https://drive.example/view',
    }]);

    const json = JSON.stringify(projected);
    for (const internal of [
      HISTORY.id,
      HISTORY.files[0].id,
      HISTORY.files[0].filename,
      'drive-secret-id',
      'notation:private-id',
      'segment:private-1',
      'topic:private-1',
    ]) {
      expect(json).not.toContain(internal);
    }
  });

  it('applies each sensitive policy dimension independently', () => {
    const projected = projectIntegrationRecording({
      externalRecordingId: 'recording_external_123',
      policy: {
        ...POLICY,
        meetingIdentity: false,
        userNote: false,
        notations: false,
        analysis: false,
        artifactLinks: false,
        transcriptSpeakers: 'omit',
      },
      source: source(),
    });

    expect(projected.source).toEqual({ kind: 'meeting' });
    expect(projected.note).toBeUndefined();
    expect(projected.notations).toBeUndefined();
    expect(projected.analysis).toBeUndefined();
    expect(projected.transcript?.segments.every((segment) => segment.speaker == null)).toBe(true);
    expect(projected.artifacts?.[0].viewUrl).toBeUndefined();
  });

  it('keeps pseudonyms stable when later revisions append new speakers', () => {
    const first = projectIntegrationRecording({
      externalRecordingId: 'recording_external_123',
      policy: POLICY,
      source: source(),
    });
    const nextSource = source();
    nextSource.transcript.segments.push({
      tStartMs: 140,
      tEndMs: 180,
      speaker: 'Carol',
      text: 'Hello',
    });
    const second = projectIntegrationRecording({
      externalRecordingId: 'recording_external_123',
      policy: POLICY,
      source: nextSource,
    });

    expect(first.transcript?.segments.map((segment) => segment.speaker)).toEqual([
      'Speaker 1', 'Speaker 2', 'Speaker 1',
    ]);
    expect(second.transcript?.segments.map((segment) => segment.speaker)).toEqual([
      'Speaker 1', 'Speaker 2', 'Speaker 1', 'Speaker 3',
    ]);
  });

  it('never reuses an existing stable pseudonym when a provided mapping is partial', () => {
    const projected = projectIntegrationRecording({
      externalRecordingId: 'recording_external_123',
      policy: POLICY,
      source: source(),
      speakerPseudonyms: new Map([
        ['Alice', 'Speaker 4'],
      ]),
    });

    expect(projected.transcript?.segments.map((segment) => segment.speaker)).toEqual([
      'Speaker 4', 'Speaker 5', 'Speaker 4',
    ]);
  });

  it('requires metadata before a recording snapshot can leave the browser', () => {
    expect(() => projectIntegrationRecording({
      externalRecordingId: 'recording_external_123',
      policy: { ...POLICY, metadata: false },
      source: source(),
    })).toThrow('metadata must be enabled');
  });
});
