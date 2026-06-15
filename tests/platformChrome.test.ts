import {
  activateTab,
  getCapturedTabs,
  getMediaStreamIdForTab,
  getTab,
} from '../src/platform/chrome/tabs';
import { downloadFile } from '../src/platform/chrome/downloads';
import {
  getAllLocalStorageValues,
  getLocalStorageValues,
  removeLocalStorageValues,
  setLocalStorageValues,
  setSessionStorageValues,
} from '../src/platform/chrome/storage';

function setLastError(message?: string) {
  (chrome.runtime as any).lastError = message ? { message } : undefined;
}

describe('platform/chrome/tabs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (globalThis as any).__E2E_MOCK_CAPTURE__ = false;
    setLastError(undefined);
  });

  describe('getMediaStreamIdForTab', () => {
    it('returns a synthetic stream id for E2E mock-capture builds', async () => {
      (globalThis as any).__E2E_MOCK_CAPTURE__ = true;
      await expect(getMediaStreamIdForTab(7)).resolves.toBe('__E2E_MOCK_TAB_CAPTURE__:7');
    });

    it('resolves the stream id from chrome.tabCapture', async () => {
      (chrome.tabCapture.getMediaStreamId as jest.Mock).mockImplementation((_opts: any, cb: (id?: string) => void) => {
        setLastError(undefined);
        cb('stream-xyz');
      });
      await expect(getMediaStreamIdForTab(42)).resolves.toBe('stream-xyz');
    });

    it('rejects when chrome reports a lastError', async () => {
      (chrome.tabCapture.getMediaStreamId as jest.Mock).mockImplementation((_opts: any, cb: (id?: string) => void) => {
        setLastError('capture failed');
        cb(undefined);
        setLastError(undefined);
      });
      await expect(getMediaStreamIdForTab(42)).rejects.toThrow('capture failed');
    });

    it('rejects when the stream id is empty', async () => {
      (chrome.tabCapture.getMediaStreamId as jest.Mock).mockImplementation((_opts: any, cb: (id?: string) => void) => {
        cb(undefined);
      });
      await expect(getMediaStreamIdForTab(42)).rejects.toThrow('Empty streamId');
    });

    it('rejects when the chrome call throws synchronously', async () => {
      (chrome.tabCapture.getMediaStreamId as jest.Mock).mockImplementation(() => {
        throw new Error('no tabCapture');
      });
      await expect(getMediaStreamIdForTab(42)).rejects.toThrow('no tabCapture');
    });
  });

  describe('getCapturedTabs', () => {
    it('resolves the captured-tabs list', async () => {
      (chrome.tabCapture.getCapturedTabs as jest.Mock).mockImplementation((cb: (r: any[]) => void) => cb([{ tabId: 1 }]));
      await expect(getCapturedTabs()).resolves.toEqual([{ tabId: 1 }]);
    });

    it('defaults to an empty array when chrome returns nothing', async () => {
      (chrome.tabCapture.getCapturedTabs as jest.Mock).mockImplementation((cb: (r?: any[]) => void) => cb(undefined));
      await expect(getCapturedTabs()).resolves.toEqual([]);
    });

    it('rejects on lastError', async () => {
      (chrome.tabCapture.getCapturedTabs as jest.Mock).mockImplementation((cb: (r?: any[]) => void) => {
        setLastError('boom');
        cb(undefined);
        setLastError(undefined);
      });
      await expect(getCapturedTabs()).rejects.toThrow('boom');
    });
  });

  describe('getTab', () => {
    it('returns the tab when chrome resolves it', async () => {
      (chrome.tabs.get as jest.Mock).mockResolvedValueOnce({ id: 42, url: 'https://meet.google.com/x' });
      await expect(getTab(42)).resolves.toEqual({ id: 42, url: 'https://meet.google.com/x' });
    });

    it('returns null when the tab no longer exists', async () => {
      (chrome.tabs.get as jest.Mock).mockRejectedValueOnce(new Error('No tab with id'));
      await expect(getTab(42)).resolves.toBeNull();
    });
  });

  it('activates a tab without changing its URL', async () => {
    (chrome.tabs.update as jest.Mock).mockResolvedValueOnce({ id: 42, active: true });

    await expect(activateTab(42)).resolves.toBeUndefined();
    expect(chrome.tabs.update).toHaveBeenCalledWith(42, { active: true });
  });
});

describe('platform/chrome/downloads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setLastError(undefined);
  });

  it('resolves the download id on success', async () => {
    (chrome.downloads.download as jest.Mock).mockImplementation((_opts: any, cb: (id?: number) => void) => cb(123));
    await expect(downloadFile({ url: 'blob:1', filename: 'tab.webm' })).resolves.toBe(123);
  });

  it('rejects when chrome reports a download error', async () => {
    (chrome.downloads.download as jest.Mock).mockImplementation((_opts: any, cb: (id?: number) => void) => {
      setLastError('Download blocked');
      cb(undefined);
      setLastError(undefined);
    });
    await expect(downloadFile({ url: 'blob:1', filename: 'tab.webm' })).rejects.toThrow('Download blocked');
  });
});

describe('platform/chrome/storage (host without chrome.storage)', () => {
  let savedStorage: typeof chrome.storage;

  beforeEach(() => {
    savedStorage = chrome.storage;
    // Simulate a runtime that exposes `chrome` but not `chrome.storage` (e.g. the
    // e2e tab-capture recorder runtime). Reading `chrome.storage.local` directly
    // here is what produced "Cannot read properties of undefined (reading 'local')"
    // and aborted the stop/finalize pipeline.
    (chrome as any).storage = undefined;
  });

  afterEach(() => {
    (chrome as any).storage = savedStorage;
  });

  it('degrades to a safe no-op instead of throwing on local reads/writes', async () => {
    await expect(getLocalStorageValues('k')).resolves.toEqual({});
    await expect(getAllLocalStorageValues()).resolves.toEqual({});
    await expect(setLocalStorageValues({ k: 1 })).resolves.toBeUndefined();
    await expect(removeLocalStorageValues('k')).resolves.toBeUndefined();
    await expect(setSessionStorageValues({ k: 1 })).resolves.toBeUndefined();
  });
});
