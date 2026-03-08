import { CameraPermissionService } from '../src/popup/CameraPermissionService';
import { MicPermissionService } from '../src/popup/MicPermissionService';
import { PopupController } from '../src/popup/PopupController';
import type { RecordingRunConfig } from '../src/shared/recording';

jest.mock('../src/popup/MicPermissionService');
jest.mock('../src/popup/CameraPermissionService');

describe('PopupController', () => {
  let controller: PopupController;
  let elements: any;
  let mockSendMessage: jest.Mock;
  let mockTabsQuery: jest.Mock;

  beforeEach(() => {
    const makeRunConfig = (overrides: Partial<RecordingRunConfig> = {}): RecordingRunConfig => ({
      storageMode: 'local',
      micMode: 'off',
      recordSelfVideo: false,
      ...overrides,
    });
    (global as any).__TEST_RUN_CONFIG__ = makeRunConfig;

    elements = {
      saveBtn: document.createElement('button'),
      micBtn: document.createElement('button'),
      micModeSelect: document.createElement('select'),
      startBtn: document.createElement('button'),
      stopBtn: document.createElement('button'),
      storageModeSelect: document.createElement('select'),
      recordSelfVideoCheckbox: document.createElement('input'),
      openDiagnosticsBtn: document.createElement('button'),
      recordingStatusEl: document.createElement('div'),
    };
    elements.recordSelfVideoCheckbox.type = 'checkbox';

    const optLocal = document.createElement('option');
    optLocal.value = 'local';
    const optDrive = document.createElement('option');
    optDrive.value = 'drive';
    elements.storageModeSelect.appendChild(optLocal);
    elements.storageModeSelect.appendChild(optDrive);
    ['off', 'mixed', 'separate'].forEach((value: string) => {
      const option = document.createElement('option');
      option.value = value;
      elements.micModeSelect.appendChild(option);
    });

    mockSendMessage = chrome.runtime.sendMessage as jest.Mock;
    mockSendMessage.mockResolvedValue({
      session: {
        phase: 'idle',
        runConfig: null,
        updatedAt: Date.now(),
      },
    });

    mockTabsQuery = chrome.tabs.query as jest.Mock;
    mockTabsQuery.mockResolvedValue([{ id: 101, url: 'https://meet.google.com/abc-defg' }]);

    (CameraPermissionService.prototype.ensureReadyForRecording as jest.Mock).mockResolvedValue(true);
    (MicPermissionService.prototype.ensureReadyForRecording as jest.Mock).mockResolvedValue(true);

    controller = new PopupController(elements);

    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(window, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    controller.destroy();
    (globalThis as any).__DEV_BUILD__ = false;
    jest.restoreAllMocks();
  });

  it('initializes UI correctly from existing uploading state', async () => {
    mockSendMessage.mockResolvedValueOnce({
      session: {
        phase: 'uploading',
        runConfig: {
          storageMode: 'drive',
          micMode: 'mixed',
          recordSelfVideo: true,
        },
        updatedAt: Date.now(),
      },
    });
    controller.init();
    await new Promise(process.nextTick);

    expect(mockSendMessage).toHaveBeenCalledWith({ type: 'GET_RECORDING_STATUS' });
    expect(elements.startBtn.disabled).toBe(true);
    expect(elements.stopBtn.disabled).toBe(true);
    expect(elements.storageModeSelect.disabled).toBe(true);
    expect(elements.storageModeSelect.value).toBe('drive');
    expect(elements.micModeSelect.value).toBe('mixed');
    expect(elements.recordSelfVideoCheckbox.checked).toBe(true);
    expect(elements.recordingStatusEl.textContent).toContain('Finalizing and saving files');
    expect(elements.recordingStatusEl.textContent).toContain('Mode: Drive');
  });

  it('handles START_RECORDING click', async () => {
    controller.init();
    await new Promise(process.nextTick);
    mockSendMessage.mockClear();
    (chrome.tabs.sendMessage as jest.Mock).mockClear();
    mockSendMessage.mockResolvedValueOnce({
      ok: true,
      session: {
        phase: 'recording',
        runConfig: (global as any).__TEST_RUN_CONFIG__({
          storageMode: 'drive',
          micMode: 'mixed',
          recordSelfVideo: true,
        }),
        updatedAt: Date.now(),
      },
    });

    elements.storageModeSelect.selectedIndex = 1;
    elements.micModeSelect.value = 'mixed';
    elements.recordSelfVideoCheckbox.checked = true;

    elements.startBtn.click();
    await new Promise(process.nextTick);

    expect(mockTabsQuery).toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(101, { type: 'RESET_TRANSCRIPT' });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      tabId: 101,
      runConfig: {
        storageMode: 'drive',
        micMode: 'mixed',
        recordSelfVideo: true,
      },
    });

    expect(elements.startBtn.disabled).toBe(true);
    expect(elements.stopBtn.disabled).toBe(false);
  });

  it('preserves micMode=off when starting from the popup form', async () => {
    controller.init();
    await new Promise(process.nextTick);
    mockSendMessage.mockClear();
    (chrome.tabs.sendMessage as jest.Mock).mockClear();
    mockSendMessage.mockResolvedValueOnce({
      ok: true,
      session: {
        phase: 'recording',
        runConfig: (global as any).__TEST_RUN_CONFIG__(),
        updatedAt: Date.now(),
      },
    });

    elements.storageModeSelect.value = 'local';
    elements.micModeSelect.value = 'off';
    elements.recordSelfVideoCheckbox.checked = false;

    elements.startBtn.click();
    await new Promise(process.nextTick);

    expect(MicPermissionService.prototype.ensureReadyForRecording).toHaveBeenCalledWith('off');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      tabId: 101,
      runConfig: {
        storageMode: 'local',
        micMode: 'off',
        recordSelfVideo: false,
      },
    });
  });

  it('handles STOP_RECORDING click', async () => {
    mockSendMessage.mockResolvedValueOnce({
      session: {
        phase: 'recording',
        runConfig: (global as any).__TEST_RUN_CONFIG__(),
        updatedAt: Date.now(),
      },
    });
    controller.init();
    await new Promise(process.nextTick);

    mockSendMessage.mockClear();
    mockSendMessage.mockResolvedValueOnce({
      ok: true,
      session: {
        phase: 'stopping',
        runConfig: (global as any).__TEST_RUN_CONFIG__(),
        updatedAt: Date.now(),
      },
    });
    elements.stopBtn.click();
    await new Promise(process.nextTick);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'STOP_RECORDING' });
    expect(console.log).toHaveBeenCalledWith('[popup]', expect.stringContaining('Stopping...'));
  });

  it('shows uploading status while Drive upload continues after popup stop', async () => {
    controller.init();
    await new Promise(process.nextTick);

    (controller as any).setActiveRunConfig({
      storageMode: 'drive',
      micMode: 'separate',
      recordSelfVideo: true,
    });
    (controller as any).setUI('uploading');

    expect(elements.startBtn.disabled).toBe(true);
    expect(elements.stopBtn.disabled).toBe(true);
    expect(elements.recordingStatusEl.textContent).toContain('Finalizing and saving files');
    expect(elements.recordingStatusEl.textContent).toContain('Mode: Drive');
  });

  it('shows final upload summary when some files fell back to local download', async () => {
    controller.init();
    await new Promise(process.nextTick);
    const runtimeListener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    (window.alert as jest.Mock).mockClear();

    runtimeListener({
      type: 'RECORDING_STATE',
      session: {
        phase: 'uploading',
        runConfig: (global as any).__TEST_RUN_CONFIG__({ storageMode: 'drive' }),
        updatedAt: Date.now(),
      },
    });
    runtimeListener({
      type: 'RECORDING_STATE',
      session: {
        phase: 'idle',
        runConfig: null,
        updatedAt: Date.now(),
        uploadSummary: {
          uploaded: [{ stream: 'mic', filename: 'google-meet-mic-x.webm' }],
          localFallbacks: [
            {
              stream: 'tab',
              filename: 'google-meet-recording-x.webm',
              error: 'AbortError: signal is aborted without reason',
            },
          ],
        },
      },
    });

    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining('Saved locally instead')
    );
    expect(window.alert).toHaveBeenCalledWith(
      expect.stringContaining('google-meet-recording-x.webm')
    );
  });

  it('alerts when local fallback download fails', async () => {
    controller.init();
    await new Promise(process.nextTick);
    const runtimeListener = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
    (window.alert as jest.Mock).mockClear();
    (console.log as jest.Mock).mockClear();

    runtimeListener({
      type: 'RECORDING_SAVE_ERROR',
      filename: 'google-meet-recording-x.webm',
      error: 'Download blocked',
    });

    expect(console.log).toHaveBeenCalledWith(
      '[popup]',
      expect.stringContaining('Local save failed: google-meet-recording-x.webm')
    );
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Download blocked'));
  });

  it('shows the diagnostics button only in dev builds and opens the dashboard tab', async () => {
    (globalThis as any).__DEV_BUILD__ = true;
    controller.init();
    await new Promise(process.nextTick);

    expect(elements.openDiagnosticsBtn.hidden).toBe(false);

    elements.openDiagnosticsBtn.click();
    await new Promise(process.nextTick);

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://mock-id/debug.html',
    });
    (globalThis as any).__DEV_BUILD__ = false;
  });

  it('hides the diagnostics button in production builds', async () => {
    (globalThis as any).__DEV_BUILD__ = false;
    controller.init();
    await new Promise(process.nextTick);

    expect(elements.openDiagnosticsBtn.hidden).toBe(true);
  });
});
