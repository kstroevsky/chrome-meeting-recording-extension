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
});
