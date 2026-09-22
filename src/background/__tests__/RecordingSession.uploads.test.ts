import { RecordingSession } from '../recording/session/RecordingSession';
import type { RecordingRunConfig } from '../../shared/recording';

const RUN_CONFIG: RecordingRunConfig = {
  storageMode: 'drive',
  micMode: 'separate',
  recordSelfVideo: true,
};

describe('RecordingSession upload jobs', () => {
  let persist: jest.Mock;
  let onChanged: jest.Mock;
  let session: RecordingSession;

  beforeEach(() => {
    persist = jest.fn();
    onChanged = jest.fn();
    session = new RecordingSession(persist, onChanged);
  });

  describe('background upload jobs (ADR-0004)', () => {
    const job = (id: string, over: Partial<import('../../shared/recording').UploadJob> = {}) => ({
      id,
      label: id,
      status: 'uploading' as const,
      progress: 0,
      files: [],
      startedAt: 1000,
      ...over,
    });

    it('inserts a new upload job and updates it by id', async () => {
      const inserted = session.upsertUploadJob(job('j1'));
      expect(inserted.uploadJobs).toEqual([job('j1')]);

      const updated = session.upsertUploadJob(job('j1', { progress: 0.5, status: 'completed' }));
      expect(updated.uploadJobs).toHaveLength(1);
      expect(updated.uploadJobs?.[0]).toMatchObject({ id: 'j1', progress: 0.5, status: 'completed' });

      await session.flush();
      expect(persist).toHaveBeenCalledWith(updated);
      expect(onChanged).toHaveBeenCalledWith(updated);
    });

    it('keeps multiple jobs and removes one by id', () => {
      session.upsertUploadJob(job('j1'));
      session.upsertUploadJob(job('j2'));
      expect(session.getSnapshot().uploadJobs?.map((j) => j.id)).toEqual(['j1', 'j2']);

      const afterRemove = session.removeUploadJob('j1');
      expect(afterRemove.uploadJobs?.map((j) => j.id)).toEqual(['j2']);

      // Removing the last job drops the list entirely (optional-field convention).
      expect(session.removeUploadJob('j2').uploadJobs).toBeUndefined();
    });

    it('carries in-flight jobs across a new recording, stop, and idle', () => {
      session.upsertUploadJob(job('j1'));

      // Starting a new recording must NOT drop the previous recording's upload.
      const started = session.start(RUN_CONFIG, { targetTabId: 7 });
      expect(started.phase).toBe('starting');
      expect(started.uploadJobs?.map((j) => j.id)).toEqual(['j1']);

      session.applyOffscreenPhase({ phase: 'recording' });
      const stopping = session.markStopping();
      expect(stopping.uploadJobs?.map((j) => j.id)).toEqual(['j1']);

      const idle = session.markIdle();
      expect(idle.uploadJobs?.map((j) => j.id)).toEqual(['j1']);
    });

    it('preserves jobs through a failure', () => {
      session.upsertUploadJob(job('j1'));
      session.start(RUN_CONFIG, { targetTabId: 7 });
      const failed = session.fail('boom');
      expect(failed.phase).toBe('failed');
      expect(failed.uploadJobs?.map((j) => j.id)).toEqual(['j1']);
    });
  });
});
