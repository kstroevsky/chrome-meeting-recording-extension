import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { RecordingContextRepository } from '../RecordingContextRepository';

describe('RecordingContextRepository', () => {
  it('persists context before any history row exists and finishes it idempotently', async () => {
    const repository = new RecordingContextRepository(new IDBFactory());
    await repository.put({
      recordingId: 'rec_1',
      startedAt: 100,
      source: {
        kind: 'meeting',
        provider: 'google-meet',
        meetingId: 'abc-defg-hij',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      },
    });

    await expect(repository.get('rec_1')).resolves.toEqual({
      recordingId: 'rec_1',
      startedAt: 100,
      source: {
        kind: 'meeting',
        provider: 'google-meet',
        meetingId: 'abc-defg-hij',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      },
    });

    await repository.finish('rec_1', 250);
    await repository.finish('rec_1', 900);
    await expect(repository.get('rec_1')).resolves.toEqual(expect.objectContaining({
      startedAt: 100,
      endedAt: 250,
    }));
  });

  it('removes the aggregate independently of recording history', async () => {
    const repository = new RecordingContextRepository(new IDBFactory());
    await repository.put({
      recordingId: 'rec_2',
      startedAt: 100,
      source: { kind: 'tab' },
    });

    await repository.remove('rec_2');

    await expect(repository.get('rec_2')).resolves.toBeUndefined();
  });
});
