import { LocalFileTarget } from '../LocalFileTarget';
import {
  configurePerfRuntime,
  resetPerfFlags,
  type PerfEventEntry,
} from '../../shared/perf';

async function toText(payload: unknown): Promise<string> {
  const asAny = payload as any;
  if (typeof asAny?.text === 'function') return asAny.text();
  if (typeof asAny?.arrayBuffer === 'function') {
    const ab = await asAny.arrayBuffer();
    return new TextDecoder().decode(ab);
  }
  if (typeof FileReader !== 'undefined' && typeof asAny?.size === 'number' && typeof asAny?.slice === 'function') {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.readAsText(asAny as Blob);
    });
  }
  return String(payload ?? '');
}

describe('LocalFileTarget', () => {
  let mockGetDirectory: jest.Mock;
  let mockGetFileHandle: jest.Mock;
  let mockCreateWritable: jest.Mock;
  let mockWrite: jest.Mock;
  let mockClose: jest.Mock;
  let mockGetFile: jest.Mock;
  let mockRemoveEntry: jest.Mock;

  beforeEach(() => {
    mockWrite = jest.fn().mockResolvedValue(undefined);
    mockClose = jest.fn().mockResolvedValue(undefined);
    mockCreateWritable = jest.fn().mockResolvedValue({
      write: mockWrite,
      close: mockClose,
    });
    mockGetFile = jest.fn().mockResolvedValue(new File(['test'], 'test.webm', { type: 'video/webm' }));
    mockGetFileHandle = jest.fn().mockResolvedValue({
      createWritable: mockCreateWritable,
      getFile: mockGetFile,
    });
    mockRemoveEntry = jest.fn().mockResolvedValue(undefined);
    mockGetDirectory = jest.fn().mockResolvedValue({
      getFileHandle: mockGetFileHandle,
      removeEntry: mockRemoveEntry,
    });

    Object.defineProperty(global.navigator, 'storage', {
      value: { getDirectory: mockGetDirectory },
      writable: true,
    });
  });

  afterEach(() => {
    resetPerfFlags();
    (globalThis as any).__DEV_BUILD__ = false;
    jest.restoreAllMocks();
  });

  it('emits OPFS open, write, close, and cleanup diagnostics', async () => {
    (globalThis as any).__DEV_BUILD__ = true;
    const events: PerfEventEntry[] = [];
    await configurePerfRuntime({
      source: 'offscreen',
      sink: (entry) => { events.push(entry); },
    });

    const target = await LocalFileTarget.create('test.webm', 'tab');
    await target.write(new Blob(['abc']));
    const artifact = await target.close();
    await artifact?.cleanup();

    expect(events.map((entry) => `${entry.scope}:${entry.event}`)).toEqual(
      expect.arrayContaining([
        'storage:opfs_opened',
        'storage:opfs_write_complete',
        'storage:opfs_closed',
        'storage:opfs_cleanup',
      ])
    );
    for (const entry of events) {
      if (typeof entry.fields.durationMs === 'number') {
        expect(entry.fields.durationMs).toBeGreaterThanOrEqual(0);
      }
    }
    const writeEvent = events.find((entry) => entry.event === 'opfs_write_complete');
    expect(writeEvent?.fields.pendingWrites).toBe(0);
    expect(writeEvent?.fields.peakPendingWrites).toBe(1);
  });

  it('creates and writes chunks', async () => {
    const target = await LocalFileTarget.create('test.webm');

    expect(mockGetDirectory).toHaveBeenCalled();
    expect(mockGetFileHandle).toHaveBeenCalledWith('test.webm', { create: true });
    expect(mockCreateWritable).toHaveBeenCalled();

    const chunk1 = new Blob(['1']);
    const chunk2 = new Blob(['2']);

    await target.write(chunk1);
    await target.write(chunk2);

    expect(mockWrite).toHaveBeenCalledTimes(2);
    expect(mockWrite).toHaveBeenNthCalledWith(1, chunk1);
    expect(mockWrite).toHaveBeenNthCalledWith(2, chunk2);
  });

  it('returns a sealed artifact on close', async () => {
    const target = await LocalFileTarget.create('test.webm');
    await target.write(new Blob(['abc']));
    const artifact = await target.close();

    expect(mockClose).toHaveBeenCalled();
    expect(mockGetFile).toHaveBeenCalled();
    expect(artifact?.filename).toBe('test.webm');
    expect(artifact?.opfsFilename).toBe('test.webm');
    expect(await toText(artifact?.file)).toBe('test');
  });

  it('cleanup removes the OPFS temp file', async () => {
    const target = await LocalFileTarget.create('test.webm');
    await target.write(new Blob(['abc']));
    const artifact = await target.close();

    await artifact?.cleanup();

    expect(mockRemoveEntry).toHaveBeenCalledWith('test.webm');
  });

  it('deletes empty temp files instead of returning an artifact', async () => {
    const target = await LocalFileTarget.create('empty.webm');
    const artifact = await target.close();

    expect(artifact).toBeNull();
    expect(mockRemoveEntry).toHaveBeenCalledWith('empty.webm');
  });
});
