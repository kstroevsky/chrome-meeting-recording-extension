jest.mock('../src/platform/chrome/downloads', () => ({
  downloadFile: jest.fn().mockResolvedValue(1),
}));
jest.mock('../src/platform/chrome/runtime', () => ({
  pokeRuntime: jest.fn(),
}));
jest.mock('../src/shared/messages', () => ({
  broadcastToPopup: jest.fn().mockResolvedValue(undefined),
}));

import {
  maybeClearPerfDiagnostics,
  registerSaveHandler,
  startKeepAlive,
  stopKeepAlive,
} from '../src/background/sessionLifecycle';
import { downloadFile } from '../src/platform/chrome/downloads';
import { pokeRuntime } from '../src/platform/chrome/runtime';
import { broadcastToPopup } from '../src/shared/messages';

async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('registerSaveHandler', () => {
  let offscreen: any;
  let L: { log: jest.Mock; warn: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    offscreen = { onSaveRequested: undefined, revokeBlobUrl: jest.fn() };
    L = { log: jest.fn(), warn: jest.fn() };
    registerSaveHandler(offscreen, L);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('downloads the file, broadcasts success, then revokes the blob after a delay', async () => {
    offscreen.onSaveRequested({ filename: 'tab.webm', blobUrl: 'blob:1', opfsFilename: 'tab.webm' });
    await flushMicrotasks();

    expect(downloadFile).toHaveBeenCalledWith({ url: 'blob:1', filename: 'tab.webm', saveAs: false });
    expect(broadcastToPopup).toHaveBeenCalledWith({ type: 'RECORDING_SAVED', filename: 'tab.webm' });
    expect(offscreen.revokeBlobUrl).not.toHaveBeenCalled();

    jest.advanceTimersByTime(10_000);
    expect(offscreen.revokeBlobUrl).toHaveBeenCalledWith('blob:1', 'tab.webm');
  });

  it('broadcasts a save error and revokes without the opfs filename when the download fails', async () => {
    (downloadFile as jest.Mock).mockRejectedValueOnce(new Error('Download blocked'));

    offscreen.onSaveRequested({ filename: 'tab.webm', blobUrl: 'blob:1', opfsFilename: 'tab.webm' });
    await flushMicrotasks();

    expect(L.warn).toHaveBeenCalledWith('downloads.download error:', 'Download blocked');
    expect(broadcastToPopup).toHaveBeenCalledWith({
      type: 'RECORDING_SAVE_ERROR',
      filename: 'tab.webm',
      error: 'Download blocked',
    });

    jest.advanceTimersByTime(10_000);
    expect(offscreen.revokeBlobUrl).toHaveBeenCalledWith('blob:1', undefined);
  });

  it('stringifies a non-Error download rejection', async () => {
    (downloadFile as jest.Mock).mockRejectedValueOnce('plain failure');

    offscreen.onSaveRequested({ filename: 'tab.webm', blobUrl: 'blob:1' });
    await flushMicrotasks();

    expect(L.warn).toHaveBeenCalledWith('downloads.download error:', 'plain failure');
    expect(broadcastToPopup).toHaveBeenCalledWith({
      type: 'RECORDING_SAVE_ERROR',
      filename: 'tab.webm',
      error: 'plain failure',
    });
  });

  it('synthesizes a fallback filename when none is provided', async () => {
    offscreen.onSaveRequested({ filename: '   ', blobUrl: 'blob:1' });
    await flushMicrotasks();

    const downloadArg = (downloadFile as jest.Mock).mock.calls[0][0];
    expect(downloadArg.filename).toMatch(/^google-meet-.*recording\.webm$/);
  });

  it('does nothing when no blobUrl is present', async () => {
    offscreen.onSaveRequested({ filename: 'tab.webm', blobUrl: '' });
    await flushMicrotasks();

    expect(downloadFile).not.toHaveBeenCalled();
  });
});

describe('maybeClearPerfDiagnostics', () => {
  function makeDeps(over: Partial<{ phase: string; hydrated: boolean; dashboards: number }>) {
    const clear = jest.fn();
    const deps = {
      session: { getSnapshot: () => ({ phase: over.phase ?? 'idle' }) } as any,
      perfDebugStore: { clear } as any,
      isSessionHydrated: () => over.hydrated ?? true,
      getActiveDebugDashboards: () => over.dashboards ?? 0,
    };
    return { deps, clear };
  }

  it('clears diagnostics when hydrated, idle, and no dashboard is open', () => {
    const { deps, clear } = makeDeps({});
    maybeClearPerfDiagnostics(deps);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('does not clear before the session has hydrated', () => {
    const { deps, clear } = makeDeps({ hydrated: false });
    maybeClearPerfDiagnostics(deps);
    expect(clear).not.toHaveBeenCalled();
  });

  it('does not clear while a debug dashboard is open', () => {
    const { deps, clear } = makeDeps({ dashboards: 1 });
    maybeClearPerfDiagnostics(deps);
    expect(clear).not.toHaveBeenCalled();
  });

  it('does not clear while the session is busy', () => {
    const { deps, clear } = makeDeps({ phase: 'recording' });
    maybeClearPerfDiagnostics(deps);
    expect(clear).not.toHaveBeenCalled();
  });
});

describe('keep-alive loop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopKeepAlive();
    jest.useRealTimers();
  });

  it('pokes the runtime on an interval and is idempotent', () => {
    startKeepAlive();
    startKeepAlive(); // second call must not add a second interval

    jest.advanceTimersByTime(20_000);
    expect(pokeRuntime).toHaveBeenCalledTimes(1);
  });

  it('stops poking after stopKeepAlive', () => {
    startKeepAlive();
    jest.advanceTimersByTime(20_000);
    stopKeepAlive();
    jest.advanceTimersByTime(60_000);
    expect(pokeRuntime).toHaveBeenCalledTimes(1);
  });
});
