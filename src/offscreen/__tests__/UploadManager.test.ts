import { UploadManager } from '../UploadManager';
import type { JobFinalizer } from '../UploadManager';
import type { RecordingStream, UploadJob, UploadSummary } from '../../shared/recording';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function artifact(stream: RecordingStream, filename: string, over: Record<string, unknown> = {}) {
  return { stream, artifact: { filename, file: new Blob(['x']), cleanup: jest.fn(), ...over } } as any;
}

/** An artifact already promoted into the retained library. */
function retained(stream: RecordingStream, filename: string, key = `library/rec/${filename}`) {
  return artifact(stream, filename, { retainedKey: key });
}

function setup(finalize: JobFinalizer['finalize'], over: Partial<ConstructorParameters<typeof UploadManager>[0]> = {}) {
  const reports: UploadJob[] = [];
  const manager = new UploadManager({
    finalizer: { finalize },
    report: (job) => { reports.push(structuredClone(job)); },
    now: () => 1000,
    genId: (() => { let n = 0; return () => `job-${(n += 1)}`; })(),
    ...over,
  });
  return { manager, reports };
}

describe('UploadManager (ADR-0004)', () => {
  it('reports an immediate uploading state, forwards progress, then settles completed', async () => {
    const finalize = jest.fn(async (opts: any) => {
      opts.onUploadProgress?.(0.5);
      return {
        uploaded: [{
          stream: 'tab',
          filename: 'tab.webm',
          bytes: 1,
          driveFileId: 'drive-file-1',
          webViewLink: 'https://drive.google.com/file/d/drive-file-1/view',
        }],
        localFallbacks: [],
        folderWebViewLink: 'https://drive.google.com/drive/folders/folder-1',
      } as UploadSummary;
    });
    const { manager, reports } = setup(finalize);

    const id = manager.enqueue([artifact('tab', 'tab.webm')], 'recording:n');
    expect(id).toBe('job-1');
    // The first report lands synchronously so a tab appears at once.
    expect(reports[0]).toMatchObject({
      id: 'job-1',
      status: 'uploading',
      progress: 0,
      files: [{ stream: 'tab', filename: 'tab.webm', status: 'uploading' }],
    });
    expect(reports[0].files[0].bytes).toBe(1);
    expect(typeof reports[0].label).toBe('string');

    await flush();
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ historyId: 'recording:n', uploadJobId: 'job-1' }));
    expect(reports.map((r) => r.progress)).toContain(0.5); // progress forwarded
    const last = reports[reports.length - 1];
    expect(last).toMatchObject({
      status: 'completed',
      progress: 1,
      files: [{ stream: 'tab', status: 'uploaded' }],
      finishedAt: 1000,
    });
    expect(last.folderWebViewLink).toBe('https://drive.google.com/drive/folders/folder-1');
    expect(last.files[0]).toMatchObject({
      bytes: 1,
      driveFileId: 'drive-file-1',
      webViewLink: 'https://drive.google.com/file/d/drive-file-1/view',
    });
  });

  it('settles partial when some files fall back and failed when all fall back', async () => {
    const partial = setup(async () => ({
      uploaded: [{ stream: 'tab', filename: 'tab.webm' }],
      localFallbacks: [{ stream: 'mic', filename: 'mic.webm' }],
    }));
    partial.manager.enqueue([artifact('tab', 'tab.webm'), artifact('mic', 'mic.webm')]);
    await flush();
    const partialFinal = partial.reports[partial.reports.length - 1];
    expect(partialFinal.status).toBe('partial');
    expect(partialFinal.files).toEqual([
      expect.objectContaining({ stream: 'tab', filename: 'tab.webm', status: 'uploaded', bytes: 1 }),
      expect.objectContaining({ stream: 'mic', filename: 'mic.webm', status: 'fallback', bytes: 1 }),
    ]);

    const failed = setup(async () => ({
      uploaded: [],
      localFallbacks: [{ stream: 'tab', filename: 'tab.webm' }],
    }));
    failed.manager.enqueue([artifact('tab', 'tab.webm')]);
    await flush();
    expect(failed.reports[failed.reports.length - 1].status).toBe('failed');
  });

  it('reports failed when the finalizer throws', async () => {
    const { manager, reports } = setup(async () => { throw new Error('drive exploded'); });
    manager.enqueue([artifact('tab', 'tab.webm')]);
    await flush();
    const last = reports[reports.length - 1];
    expect(last.status).toBe('failed');
    expect(last.files.every((f) => f.status === 'fallback')).toBe(true);
    expect(last.finishedAt).toBe(1000);
  });

  it('runs one job at a time by default and frees the slot when each settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const finalize = jest.fn()
      .mockImplementationOnce(async () => { await gate; return { uploaded: [], localFallbacks: [] }; })
      .mockImplementationOnce(async () => ({ uploaded: [], localFallbacks: [] }));
    const { manager } = setup(finalize as any);

    manager.enqueue([artifact('tab', 'a.webm')]);
    manager.enqueue([artifact('tab', 'b.webm')]);
    await flush();

    expect(finalize).toHaveBeenCalledTimes(1); // second job is queued behind the first
    expect(manager.hasActiveJobs()).toBe(true);

    release();
    await flush();

    expect(finalize).toHaveBeenCalledTimes(2);
    expect(manager.hasActiveJobs()).toBe(false);
  });

  it('cancels an active upload and settles it as locally saved', async () => {
    const finalize = jest.fn(async (opts: any) => {
      await new Promise<void>((resolve) => opts.signal.addEventListener('abort', resolve, { once: true }));
      return {
        uploaded: [],
        localFallbacks: opts.artifacts.map((a: any) => ({ stream: a.stream, filename: a.artifact.filename })),
      };
    });
    const { manager, reports } = setup(finalize as any);
    const id = manager.enqueue([artifact('tab', 'tab.webm')]);
    await flush();

    expect(manager.cancel(id)).toBe(true);
    await flush();

    expect(finalize.mock.calls[0][0].signal.aborted).toBe(true);
    expect(reports[reports.length - 1]).toMatchObject({
      id,
      status: 'canceled',
      progress: 1,
      files: [{ filename: 'tab.webm', status: 'fallback' }],
    });
    expect(manager.cancel(id)).toBe(false);
    expect(manager.hasActiveJobs()).toBe(false);
  });

  it('keeps a queued cancellation inside the bounded job scheduler', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const finalize = jest.fn(async (opts: any) => {
      if (opts.artifacts[0].artifact.filename === 'active.webm') {
        await gate;
        return { uploaded: [{ stream: 'tab', filename: 'active.webm' }], localFallbacks: [] };
      }
      expect(opts.signal.aborted).toBe(true);
      return { uploaded: [], localFallbacks: [{ stream: 'tab', filename: 'queued.webm' }] };
    });
    const { manager, reports } = setup(finalize as any);
    manager.enqueue([artifact('tab', 'active.webm')]);
    const queuedId = manager.enqueue([artifact('tab', 'queued.webm')]);
    await flush();

    expect(manager.cancel(queuedId)).toBe(true);
    await flush();
    expect(reports).not.toContainEqual(expect.objectContaining({ id: queuedId, status: 'canceled' }));

    release();
    await flush();
    expect(reports).toContainEqual(expect.objectContaining({ id: queuedId, status: 'canceled' }));
  });

  it('retries a failed job from the retained artifacts, under the same id', async () => {
    let attempt = 0;
    const finalize = jest.fn(async () => {
      attempt += 1;
      return attempt === 1
        ? { uploaded: [], localFallbacks: [{ stream: 'tab', filename: 'tab.webm' }] } // fail first
        : { uploaded: [{ stream: 'tab', filename: 'tab.webm' }], localFallbacks: [] }; // succeed on retry
    });
    const { manager, reports } = setup(finalize as any);

    const id = manager.enqueue([artifact('tab', 'tab.webm')]);
    await flush();
    expect(reports[reports.length - 1]).toMatchObject({ id, status: 'failed' });

    expect(await manager.retry(id)).toBe(true);
    await flush();
    expect(reports[reports.length - 1]).toMatchObject({ id, status: 'completed' });
    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it('retries only the still-failed files of a partial job', async () => {
    let attempt = 0;
    const finalize = jest.fn(async (opts: any) => {
      attempt += 1;
      return attempt === 1
        ? { uploaded: [{ stream: 'tab', filename: 'tab.webm' }], localFallbacks: [{ stream: 'mic', filename: 'mic.webm' }] }
        : { uploaded: opts.artifacts.map((a: any) => ({ stream: a.stream, filename: a.artifact.filename })), localFallbacks: [] };
    });
    const { manager, reports } = setup(finalize as any);

    const id = manager.enqueue([artifact('tab', 'tab.webm'), artifact('mic', 'mic.webm')]);
    await flush();
    expect(reports[reports.length - 1].status).toBe('partial');

    expect(await manager.retry(id)).toBe(true);
    await flush();
    // The retry re-ran only the failed (mic) file.
    expect(finalize.mock.calls[1][0].artifacts.map((a: any) => a.artifact.filename)).toEqual(['mic.webm']);
    expect(reports[reports.length - 1].status).toBe('completed');
  });

  it('does not retry a succeeded, unknown, or already-evicted job', async () => {
    const { manager } = setup(async () => ({ uploaded: [{ stream: 'tab', filename: 'a.webm' }], localFallbacks: [] }));
    const id = manager.enqueue([artifact('tab', 'a.webm')]);
    await flush();
    expect(await manager.retry(id)).toBe(false); // succeeded ⇒ nothing retained
    expect(await manager.retry('no-such-job')).toBe(false);
  });

  // Every file falls back, so the job re-fails on each attempt.
  const alwaysFails = () =>
    jest.fn(async (opts: any) => ({ uploaded: [], localFallbacks: opts.artifacts.map((a: any) => ({ stream: a.stream, filename: a.artifact.filename })) }));

  it('stays retryable after a retry also fails', async () => {
    const { manager } = setup(alwaysFails() as any);
    const id = manager.enqueue([artifact('tab', 'tab.webm')]);
    await flush();
    expect(await manager.retry(id)).toBe(true);
    await flush();
    expect(await manager.retry(id)).toBe(true); // re-failed ⇒ still retryable
  });

  it('retains only the most-recent failure (a newer one evicts the older)', async () => {
    const { manager } = setup(alwaysFails() as any);
    const older = manager.enqueue([artifact('tab', 'a.webm')]);
    await flush();
    const newer = manager.enqueue([artifact('tab', 'b.webm')]);
    await flush();
    expect(await manager.retry(older)).toBe(false); // evicted by the newer failure
    expect(await manager.retry(newer)).toBe(true);
  });

  it('keeps the local-download failsafe on the original upload but skips it on retry', async () => {
    const finalize = alwaysFails();
    const { manager } = setup(finalize as any);
    const id = manager.enqueue([artifact('tab', 'tab.webm')]);
    await flush();
    expect(finalize.mock.calls[0][0].skipLocalFallback).toBe(false); // original ⇒ download on failure

    await manager.retry(id);
    await flush();
    expect(finalize.mock.calls[1][0].skipLocalFallback).toBe(true); // retry ⇒ no duplicate download
  });

  it('expires retry bytes after the retention window', async () => {
    let now = 1_000;
    const { manager } = setup(alwaysFails() as any, { now: () => now });
    const id = manager.enqueue([artifact('tab', 'tab.webm')]);
    await flush();

    now += 5 * 60 * 1000;
    expect(await manager.retry(id)).toBe(false);
  });

  it('does not retain a retry payload above the memory budget', async () => {
    const oversized = {
      stream: 'tab',
      artifact: { filename: 'large.webm', file: { size: 129 * 1024 * 1024 }, cleanup: jest.fn() },
    } as any;
    const { manager } = setup(alwaysFails() as any);
    const id = manager.enqueue([oversized]);
    await flush();

    expect(await manager.retry(id)).toBe(false);
  });

  describe('retry from the retained library', () => {
    const failOnce = () => {
      let attempt = 0;
      return jest.fn(async (opts: any) => {
        attempt += 1;
        return attempt === 1
          ? { uploaded: [], localFallbacks: [{ stream: 'tab', filename: 'tab.webm' }] }
          : { uploaded: opts.artifacts.map((a: any) => ({ stream: a.stream, filename: a.artifact.filename })), localFallbacks: [] };
      });
    };

    it('re-reads the bytes from the library instead of holding them', async () => {
      const libraryFile = new File(['retained bytes'], 'tab.webm');
      const readRetained = jest.fn(async () => libraryFile);
      const finalize = failOnce();
      const { manager, reports } = setup(finalize as any, { readRetained });

      const original = retained('tab', 'tab.webm');
      const id = manager.enqueue([original]);
      await flush();
      expect(reports[reports.length - 1].status).toBe('failed');

      expect(await manager.retry(id)).toBe(true);
      await flush();
      expect(readRetained).toHaveBeenCalledWith('library/rec/tab.webm');
      // The retry uploads the file the library handed back, not the one the
      // original job held — that File was invalidated when promotion moved it.
      const retriedArtifact = finalize.mock.calls[1][0].artifacts[0].artifact;
      expect(retriedArtifact.file).toBe(libraryFile);
      expect(retriedArtifact.file).not.toBe(original.artifact.file);
      expect(reports[reports.length - 1].status).toBe('completed');
    });

    it('gives the rehydrated artifact a cleanup that cannot delete the library copy', async () => {
      const readRetained = jest.fn(async () => new File(['retained bytes'], 'tab.webm'));
      const finalize = failOnce();
      const { manager } = setup(finalize as any, { readRetained });
      const original = retained('tab', 'tab.webm');
      const id = manager.enqueue([original]);
      await flush();
      await manager.retry(id);
      await flush();

      // The library owns these bytes; an upload deleting them would take the
      // player's only copy with it. So the rehydrated cleanup is inert, and the
      // original artifact's cleanup is never reused for the retry.
      const retriedArtifact = finalize.mock.calls[1][0].artifacts[0].artifact;
      expect(retriedArtifact.cleanup).not.toBe(original.artifact.cleanup);
      await expect(retriedArtifact.cleanup()).resolves.toBeUndefined();
      expect(original.artifact.cleanup).not.toHaveBeenCalled();
      // It still knows where it lives, so a re-failure is remembered the same way.
      expect(retriedArtifact.retainedKey).toBe('library/rec/tab.webm');
    });

    it('stays retryable past the in-memory retention window', async () => {
      const readRetained = jest.fn(async () => new File(['retained bytes'], 'tab.webm'));
      let clock = 1000;
      const { manager } = setup(failOnce() as any, { readRetained, now: () => clock });

      const id = manager.enqueue([retained('tab', 'tab.webm')]);
      await flush();
      clock += 60 * 60 * 1000; // an hour, far past the five-minute budget
      expect(await manager.retry(id)).toBe(true);
    });

    it('drops its reference to the bytes, which is the point of the library path', async () => {
      const readRetained = jest.fn(async () => new File(['retained bytes'], 'tab.webm'));
      const { manager } = setup(failOnce() as any, { readRetained });
      const original = retained('tab', 'tab.webm');
      manager.enqueue([original]);
      await flush();

      // Holding the artifacts would keep their Blobs reachable and leave the
      // offscreen document pinning the failed recording exactly as before.
      const remembered = (manager as any).lastFailed;
      expect(remembered.retainedKeys).toHaveLength(1);
      expect(remembered.artifacts).toBeUndefined();
    });

    it('stays retryable past the byte budget', async () => {
      const readRetained = jest.fn(async () => new File(['retained bytes'], 'tab.webm'));
      const warn = jest.fn();
      const huge = retained('tab', 'tab.webm');
      // 512 MB — four times the in-memory budget that used to drop Retry.
      Object.defineProperty(huge.artifact.file, 'size', { value: 512 * 1024 * 1024 });
      const { manager } = setup(failOnce() as any, { readRetained, warn });

      const id = manager.enqueue([huge]);
      await flush();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('retention budget'));
      expect(await manager.retry(id)).toBe(true);
    });

    it('reports the job unretryable when the library no longer holds it', async () => {
      const readRetained = jest.fn(async () => null);
      const { manager } = setup(failOnce() as any, { readRetained });

      const id = manager.enqueue([retained('tab', 'tab.webm')]);
      await flush();
      expect(await manager.retry(id)).toBe(false);
      // And it does not stay half-remembered for a second attempt.
      expect(await manager.retry(id)).toBe(false);
    });

    it('falls back to the in-memory budget when the files were never promoted', async () => {
      const readRetained = jest.fn(async () => new File(['x'], 'tab.webm'));
      let clock = 1000;
      const { manager } = setup(failOnce() as any, { readRetained, now: () => clock });

      const id = manager.enqueue([artifact('tab', 'tab.webm')]);
      await flush();
      clock += 60 * 60 * 1000;
      expect(await manager.retry(id)).toBe(false);
      expect(readRetained).not.toHaveBeenCalled();
    });
  });
});
