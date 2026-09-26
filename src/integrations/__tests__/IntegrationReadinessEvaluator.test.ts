import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import { IntegrationReadinessEvaluator } from '../IntegrationReadinessEvaluator';
import { CONSERVATIVE_INTEGRATION_POLICY } from '../policy';

function history(delivery: 'pending' | 'uploaded' = 'uploaded'): RecordingHistoryEntry {
  return {
    id: 'recording_1',
    name: 'Recording',
    createdAt: 1,
    storageMode: 'drive',
    status: delivery === 'pending' ? 'saving' : 'complete',
    files: [{
      id: 'recording_1:tab',
      stream: 'tab',
      filename: 'recording.webm',
      mimeType: 'video/webm',
      locations: delivery === 'uploaded'
        ? [{ kind: 'drive', fileId: 'drive-file', webViewLink: 'https://drive.example/file' }]
        : [],
      delivery: { requested: 'drive', status: delivery },
      destination: 'drive',
      status: delivery === 'pending' ? 'pending' : 'available',
    }],
  };
}

describe('IntegrationReadinessEvaluator', () => {
  const evaluator = new IntegrationReadinessEvaluator();

  it('waits only for destination-requested asynchronous data', () => {
    expect(evaluator.evaluate({
      history: history('pending'),
      analysis: { status: 'analyzing' },
    }, {
      ...CONSERVATIVE_INTEGRATION_POLICY,
      metadata: true,
      transcript: true,
      analysis: true,
      artifactMetadata: true,
      artifactLinks: true,
    })).toEqual({
      complete: false,
      pending: ['transcript', 'analysis', 'artifact-delivery'],
    });
  });

  it.each(['completed', 'failed', 'canceled', 'unsupported', 'stale'] as const)(
    'treats %s analysis as terminal',
    (status) => {
      expect(evaluator.evaluate({
        history: history(),
        analysis: { status },
      }, {
        ...CONSERVATIVE_INTEGRATION_POLICY,
        metadata: true,
        analysis: true,
      })).toEqual({ complete: true, pending: [] });
    },
  );

  it('does not wait on pending artifacts when links are not requested', () => {
    expect(evaluator.evaluate({ history: history('pending') }, {
      ...CONSERVATIVE_INTEGRATION_POLICY,
      metadata: true,
      artifactMetadata: true,
      artifactLinks: false,
    })).toEqual({ complete: true, pending: [] });
  });
});
