import { CameraPermissionService } from '../src/popup/CameraPermissionService';
import { MicPermissionService } from '../src/popup/MicPermissionService';
import { PopupController } from '../src/popup/PopupController';
import { POPUP_TOAST_DURATION_MS } from '../src/popup/popupMessages';
import type { RecordingRunConfig } from '../src/shared/recording';

jest.mock('../src/popup/MicPermissionService');
jest.mock('../src/popup/CameraPermissionService');

describe('PopupController', () => {
  let controller: PopupController;
  let elements: any;
  let mockSendMessage: jest.Mock;
  let mockTabsQuery: jest.Mock;
  let mockTabSendMessage: jest.Mock;

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
      openSettingsBtn: document.createElement('button'),
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
    mockTabSendMessage = chrome.tabs.sendMessage as jest.Mock;
    mockTabSendMessage.mockImplementation(async (_tabId: number, message: { type: string }) => {
      if (message.type === 'RESET_TRANSCRIPT') return { ok: true };
      return undefined;
    });

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

  it('shows the first recording warning in popup status', async () => {
    controller.init();
    await new Promise(process.nextTick);
    (controller as any).state.applySession({
      phase: 'recording',
      runConfig: (global as any).__TEST_RUN_CONFIG__({ recordSelfVideo: true }),
      warnings: ['Tab recording requested 640x360@24fps, but recorder input is 1920x1080@24fps.'],
      updatedAt: Date.now(),
    });

    expect(elements.recordingStatusEl.textContent).toContain(
      'Warning: Tab recording requested 640x360@24fps'
    );
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

    (controller as any).state.applySession({
      phase: 'uploading',
      runConfig: { storageMode: 'drive', micMode: 'separate', recordSelfVideo: true },
      updatedAt: Date.now(),
    });

    expect(elements.startBtn.disabled).toBe(true);
    expect(elements.stopBtn.disabled).toBe(true);
    expect(elements.recordingStatusEl.textContent).toContain('Finalizing and saving files');
    expect(elements.recordingStatusEl.textContent).toContain('Mode: Drive');
  });

  it('opens the settings page from the gear button', async () => {
    controller.init();
    await new Promise(process.nextTick);

    elements.openSettingsBtn.click();
    await new Promise(process.nextTick);

    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://mock-id/settings.html',
    });
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

  it('downloads the transcript from the active meeting tab', async () => {
    controller.init();
    await new Promise(process.nextTick);
    (chrome.tabs.sendMessage as jest.Mock).mockImplementation(async (_id: number, message: { type: string }) => {
      if (message.type === 'GET_TRANSCRIPT') return { transcript: 'Alice : hi', provider: { meetingId: 'abc-defg' } };
      return { ok: true };
    });
    (URL as any).createObjectURL = jest.fn().mockReturnValue('blob:tx');
    (URL as any).revokeObjectURL = jest.fn();
    (chrome.downloads.download as jest.Mock).mockImplementation((_opts: unknown, cb: (id?: number) => void) => cb(1));

    elements.saveBtn.click();
    await new Promise(process.nextTick);
    await new Promise(process.nextTick);

    expect(chrome.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'blob:tx',
        filename: expect.stringContaining('google-meet-transcript-abc-defg'),
        saveAs: true,
      }),
      expect.any(Function)
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:tx');
  });

  it('shows a toast when the transcript is empty and skips the download', async () => {
    controller.init();
    await new Promise(process.nextTick);
    (chrome.tabs.sendMessage as jest.Mock).mockImplementation(async (_id: number, message: { type: string }) => {
      if (message.type === 'GET_TRANSCRIPT') return { transcript: '   ', provider: { meetingId: 'x' } };
      return { ok: true };
    });
    (chrome.downloads.download as jest.Mock).mockClear();

    elements.saveBtn.click();
    await new Promise(process.nextTick);
    await new Promise(process.nextTick);

    expect(elements.recordingStatusEl.textContent).toContain('Transcript is empty');
    expect(chrome.downloads.download).not.toHaveBeenCalled();
  });

  it('shows a toast when the page has no content script to read the transcript', async () => {
    controller.init();
    await new Promise(process.nextTick);
    (chrome.tabs.sendMessage as jest.Mock).mockImplementation(async (_id: number, message: { type: string }) => {
      if (message.type === 'GET_TRANSCRIPT') throw new Error('no content script');
      return { ok: true };
    });

    elements.saveBtn.click();
    await new Promise(process.nextTick);
    await new Promise(process.nextTick);

    // The catch branch toasts "No transcript on this page" (logged in test runtime).
    expect(console.log).toHaveBeenCalledWith('[popup]', expect.stringContaining('No transcript on this page'));
  });

  // onMessage.addListener accumulates across tests (chrome mock is not reset),
  // so the current controller's listener is the most recently registered one.
  const currentRuntimeListener = () => {
    const calls = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls;
    return calls[calls.length - 1][0];
  };

  it('toasts the saved-locally confirmation on RECORDING_SAVED', async () => {
    controller.init();
    await new Promise(process.nextTick);

    currentRuntimeListener()({ type: 'RECORDING_SAVED', filename: 'tab.webm' });

    expect(elements.recordingStatusEl.textContent).toContain('Saved locally: tab.webm');
  });

  it('restores the persistent status after a toast expires', async () => {
    controller.init();
    await new Promise(process.nextTick);
    const persistent = elements.recordingStatusEl.textContent;
    const runtimeListener = currentRuntimeListener();

    jest.useFakeTimers();
    try {
      runtimeListener({ type: 'RECORDING_SAVED', filename: 'tab.webm' });
      expect(elements.recordingStatusEl.textContent).toContain('Saved locally');
      // A second toast clears the first pending restore timer before scheduling its own.
      runtimeListener({ type: 'RECORDING_SAVED', filename: 'mic.webm' });

      jest.advanceTimersByTime(POPUP_TOAST_DURATION_MS);
      expect(elements.recordingStatusEl.textContent).toBe(persistent);
    } finally {
      jest.useRealTimers();
    }
  });

  it('alerts and resets to idle when the start command throws', async () => {
    (MicPermissionService.prototype.ensureReadyForRecording as jest.Mock).mockResolvedValue(false);
    controller.init();
    await new Promise(process.nextTick);
    elements.micModeSelect.value = 'mixed';

    elements.startBtn.click();
    await new Promise(process.nextTick);
    await new Promise(process.nextTick);

    expect(console.error).toHaveBeenCalledWith('[popup] START_RECORDING error', expect.any(Error));
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Failed to start recording'));
    expect(elements.startBtn.disabled).toBe(false);
  });

  describe('mic mute toggle', () => {
    const addMuteButton = () => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      const label = document.createElement('span');
      label.setAttribute('data-mute-label', '');
      label.textContent = 'Mute Mic';
      btn.appendChild(label);
      elements.muteMicBtn = btn;
      return { btn, label };
    };

    it('shows the toggle and mutes the mic during a mic recording', async () => {
      const { btn, label } = addMuteButton();
      mockSendMessage.mockResolvedValueOnce({
        session: {
          phase: 'recording',
          runConfig: { storageMode: 'local', micMode: 'separate', recordSelfVideo: false },
          updatedAt: Date.now(),
        },
      });
      controller.init();
      await new Promise(process.nextTick);

      expect(btn.hidden).toBe(false);
      expect(label.textContent).toBe('Mute Mic');
      expect(btn.getAttribute('aria-pressed')).toBe('false');

      mockSendMessage.mockClear();
      mockSendMessage.mockResolvedValueOnce({
        ok: true,
        session: {
          phase: 'recording',
          runConfig: { storageMode: 'local', micMode: 'separate', recordSelfVideo: false },
          micMuted: true,
          updatedAt: Date.now(),
        },
      });

      btn.click();
      await new Promise(process.nextTick);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'SET_MIC_MUTED', muted: true });
      expect(label.textContent).toBe('Unmute Mic');
      expect(btn.getAttribute('aria-pressed')).toBe('true');
      expect(btn.classList.contains('btn-danger')).toBe(true);
    });

    it('hides the toggle when the recording has no microphone', async () => {
      const { btn } = addMuteButton();
      mockSendMessage.mockResolvedValueOnce({
        session: {
          phase: 'recording',
          runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
          updatedAt: Date.now(),
        },
      });
      controller.init();
      await new Promise(process.nextTick);

      expect(btn.hidden).toBe(true);
    });
  });

  describe('hide-camera toggle', () => {
    const addCameraButton = () => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      const label = document.createElement('span');
      label.setAttribute('data-camera-label', '');
      label.textContent = 'Hide Camera';
      btn.appendChild(label);
      elements.hideCameraBtn = btn;
      return { btn, label };
    };

    it('shows the toggle and hides the camera during a self-video recording', async () => {
      const { btn, label } = addCameraButton();
      mockSendMessage.mockResolvedValueOnce({
        session: {
          phase: 'recording',
          runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: true },
          updatedAt: Date.now(),
        },
      });
      controller.init();
      await new Promise(process.nextTick);

      expect(btn.hidden).toBe(false);
      expect(label.textContent).toBe('Hide Camera');

      mockSendMessage.mockClear();
      mockSendMessage.mockResolvedValueOnce({
        ok: true,
        session: {
          phase: 'recording',
          runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: true },
          cameraMuted: true,
          updatedAt: Date.now(),
        },
      });

      btn.click();
      await new Promise(process.nextTick);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'SET_CAMERA_MUTED', muted: true });
      expect(label.textContent).toBe('Show Camera');
      expect(btn.getAttribute('aria-pressed')).toBe('true');
      expect(btn.classList.contains('btn-danger')).toBe(true);
    });

    it('hides the toggle when the recording has no camera', async () => {
      const { btn } = addCameraButton();
      mockSendMessage.mockResolvedValueOnce({
        session: {
          phase: 'recording',
          runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
          updatedAt: Date.now(),
        },
      });
      controller.init();
      await new Promise(process.nextTick);

      expect(btn.hidden).toBe(true);
    });
  });
});
