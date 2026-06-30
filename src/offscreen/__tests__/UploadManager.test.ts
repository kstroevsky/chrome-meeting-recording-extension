import { UploadManager } from '../UploadManager';
import type { JobFinalizer } from '../UploadManager';
import type { RecordingStream, UploadJob, UploadSummary } from '../../shared/recording';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function artifact(stream: RecordingStream, filename: string) {
  return { stream, artifact: { filename, file: new Blob(['x']), cleanup: jest.fn() } } as any;
}

function setup(finalize: JobFinalizer['finalize'], over: Partial<ConstructorParameters<typeof UploadManager>[0]> = {}) {
  const reports: UploadJob[] = [];
  const manager = new UploadManager({
    finalizer: { finalize },
    report: (job) => reports.push(structuredClone(job)),
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
      return { uploaded: [{ stream: 'tab', filename: 'tab.webm' }], localFallbacks: [] } as UploadSummary;
    });
    const { manager, reports } = setup(finalize);

    const id = manager.enqueue([artifact('tab', 'tab.webm')]);
    expect(id).toBe('job-1');
    // The first report lands synchronously so a tab appears at once.
    expect(reports[0]).toMatchObject({
      id: 'job-1',
      status: 'uploading',
      progress: 0,
      files: [{ stream: 'tab', filename: 'tab.webm', status: 'uploading' }],
    });
    expect(typeof reports[0].label).toBe('string');

    await flush();
    expect(reports.map((r) => r.progress)).toContain(0.5); // progress forwarded
    const last = reports[reports.length - 1];
    expect(last).toMatchObject({
      status: 'completed',
      progress: 1,
      files: [{ stream: 'tab', status: 'uploaded' }],
      finishedAt: 1000,
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
      { stream: 'tab', filename: 'tab.webm', status: 'uploaded' },
      { stream: 'mic', filename: 'mic.webm', status: 'fallback' },
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

    expect(manager.retry(id)).toBe(true);
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

    expect(manager.retry(id)).toBe(true);
    await flush();
    // The retry re-ran only the failed (mic) file.
    expect(finalize.mock.calls[1][0].artifacts.map((a: any) => a.artifact.filename)).toEqual(['mic.webm']);
    expect(reports[reports.length - 1].status).toBe('completed');
  });

  it('does not retry a succeeded, unknown, or already-evicted job', async () => {
    const { manager } = setup(async () => ({ uploaded: [{ stream: 'tab', filename: 'a.webm' }], localFallbacks: [] }));
    const id = manager.enqueue([artifact('tab', 'a.webm')]);
    await flush();
    expect(manager.retry(id)).toBe(false); // succeeded ⇒ nothing retained
    expect(manager.retry('no-such-job')).toBe(false);
  });

  // Every file falls back, so the job re-fails on each attempt.
  const alwaysFails = () =>
    jest.fn(async (opts: any) => ({ uploaded: [], localFallbacks: opts.artifacts.map((a: any) => ({ stream: a.stream, filename: a.artifact.filename })) }));

  it('stays retryable after a retry also fails', async () => {
    const { manager } = setup(alwaysFails() as any);
    const id = manager.enqueue([artifact('tab', 'tab.webm')]);
    await flush();
    expect(manager.retry(id)).toBe(true);
    await flush();
    expect(manager.retry(id)).toBe(true); // re-failed ⇒ still retryable
  });

  it('retains only the most-recent failure (a newer one evicts the older)', async () => {
    const { manager } = setup(alwaysFails() as any);
    const older = manager.enqueue([artifact('tab', 'a.webm')]);
    await flush();
    const newer = manager.enqueue([artifact('tab', 'b.webm')]);
    await flush();
    expect(manager.retry(older)).toBe(false); // evicted by the newer failure
    expect(manager.retry(newer)).toBe(true);
  });

  it('keeps the local-download failsafe on the original upload but skips it on retry', async () => {
    const finalize = alwaysFails();
    const { manager } = setup(finalize as any);
    const id = manager.enqueue([artifact('tab', 'tab.webm')]);
    await flush();
    expect(finalize.mock.calls[0][0].skipLocalFallback).toBe(false); // original ⇒ download on failure

    manager.retry(id);
    await flush();
    expect(finalize.mock.calls[1][0].skipLocalFallback).toBe(true); // retry ⇒ no duplicate download
  });
});
