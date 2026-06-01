import {
  getCapturedTabs,
  getMediaStreamIdForTab,
  getTab,
} from '../src/platform/chrome/tabs';
import { downloadFile } from '../src/platform/chrome/downloads';
import { E2E_MOCK_TAB_STREAM_ID } from '../src/shared/build';

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
      await expect(getMediaStreamIdForTab(7)).resolves.toBe(`${E2E_MOCK_TAB_STREAM_ID}:7`);
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
