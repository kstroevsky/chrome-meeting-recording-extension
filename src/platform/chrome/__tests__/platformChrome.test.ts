import {
  activateTab,
  getCapturedTabs,
  getMediaStreamIdForTab,
  getTab,
  queryTabs,
} from '../tabs';
import { addAlarmListener, clearAlarm, createAlarm, getAlarm } from '../alarms';
import { addCommandListener } from '../commands';
import { downloadFile } from '../downloads';
import { getRuntimeId, getRuntimeUrl, reloadRuntime } from '../runtime';
import {
  getAllLocalStorageValues,
  getLocalStorageValues,
  getSessionStorageValuesStrict,
  removeLocalStorageValues,
  setLocalStorageValues,
  setSessionStorageValues,
  setSessionStorageValuesStrict,
} from '../storage';
import { getSystemCpuInfo, hasSystemCpuInfo } from '../system';

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

  it('passes arbitrary queries through the normalized tabs seam', async () => {
    (chrome.tabs.query as jest.Mock).mockResolvedValueOnce([{ id: 8 }]);
    await expect(queryTabs({})).resolves.toEqual([{ id: 8 }]);
    expect(chrome.tabs.query).toHaveBeenCalledWith({});
  });
});

describe('platform/chrome runtime and event wrappers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exposes runtime identity/url and reload through the seam', () => {
    expect(getRuntimeId()).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(getRuntimeUrl('recordings.html')).toBe('chrome-extension://mock-id/recordings.html');
    reloadRuntime();
    expect(chrome.runtime.reload).toHaveBeenCalledTimes(1);
  });

  it('registers command and alarm listeners and creates alarms', async () => {
    const command = jest.fn();
    const alarm = jest.fn();
    addCommandListener(command);
    addAlarmListener(alarm);
    (chrome.alarms.get as jest.Mock).mockResolvedValueOnce({ name: 'sweep', scheduledTime: 1_000 });
    await createAlarm('sweep', { delayInMinutes: 0.5 });
    await expect(getAlarm('sweep')).resolves.toEqual({ name: 'sweep', scheduledTime: 1_000 });
    await expect(clearAlarm('sweep')).resolves.toBe(true);

    expect(chrome.commands.onCommand.addListener).toHaveBeenCalledWith(command);
    expect(chrome.alarms.onAlarm.addListener).toHaveBeenCalledWith(alarm);
    expect(chrome.alarms.create).toHaveBeenCalledWith('sweep', { delayInMinutes: 0.5 });
    expect(chrome.alarms.get).toHaveBeenCalledWith('sweep');
    expect(chrome.alarms.clear).toHaveBeenCalledWith('sweep');
  });
});

describe('platform/chrome/system', () => {
  const originalSystem = (chrome as any).system;

  afterEach(() => {
    (chrome as any).system = originalSystem;
  });

  it('reports the optional CPU API as unavailable when production omits it', async () => {
    (chrome as any).system = undefined;
    expect(hasSystemCpuInfo()).toBe(false);
    await expect(getSystemCpuInfo()).resolves.toBeNull();
  });

  it('reads CPU info when the development-only API is present', async () => {
    const info = { processors: [{ usage: { idle: 10, total: 20 } }] };
    const getInfo = jest.fn().mockResolvedValue(info);
    (chrome as any).system = { cpu: { getInfo } };

    expect(hasSystemCpuInfo()).toBe(true);
    await expect(getSystemCpuInfo()).resolves.toEqual(info);
    expect(getInfo).toHaveBeenCalledTimes(1);
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

  it('fails closed for strict background session durability operations', async () => {
    await expect(getSessionStorageValuesStrict('k')).rejects.toThrow(
      'chrome.storage.session is unavailable',
    );
    await expect(setSessionStorageValuesStrict({ k: 1 })).rejects.toThrow(
      'chrome.storage.session is unavailable',
    );
  });
});
