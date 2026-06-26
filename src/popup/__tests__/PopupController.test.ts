import { CameraPermissionService } from '../CameraPermissionService';
import { MicPermissionService } from '../MicPermissionService';
import { PopupController } from '../PopupController';
import { POPUP_TOAST_DURATION_MS } from '../popupMessages';
import type { RecordingRunConfig } from '../../shared/recording';

jest.mock('../../popup/MicPermissionService');
jest.mock('../../popup/CameraPermissionService');

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

    const pill = (labelAttr: string) => {
      const btn = document.createElement('button');
      const span = document.createElement('span');
      span.setAttribute(labelAttr, '');
      btn.appendChild(span);
      return btn;
    };

    elements = {
      // Header + config view
      saveBtn: document.createElement('button'),
      micBtn: document.createElement('button'),
      micModeSelect: document.createElement('select'),
      startBtn: document.createElement('button'),
      storageModeSelect: document.createElement('select'),
      recordSelfVideoCheckbox: document.createElement('input'),
      openSettingsBtn: document.createElement('button'),
      openDiagnosticsBtn: document.createElement('button'),

      // View containers
      viewConfig: document.createElement('section'),
      viewRecording: document.createElement('section'),
      viewFinalizing: document.createElement('section'),

      // Recording view
      recBanner: document.createElement('div'),
      recLabel: document.createElement('span'),
      recTimer: document.createElement('span'),
      chipTranscript: document.createElement('span'),
      chipTranscriptLabel: document.createElement('span'),
      chipStorage: document.createElement('span'),
      chipStorageLabel: document.createElement('span'),
      micRow: document.createElement('div'),
      micModeLabel: document.createElement('span'),
      muteMicBtn: pill('data-mute-label'),
      cameraRow: document.createElement('div'),
      hideCameraBtn: pill('data-camera-label'),
      pauseBtn: pill('data-pause-label'),
      stopBtn: document.createElement('button'),

      // Finalizing view
      finalizingLabel: document.createElement('div'),
      uploadRing: document.createElement('div'),
      uploadRingArc: document.createElement('div'),
      uploadRingLabel: document.createElement('span'),
      metaStorage: document.createElement('span'),
      metaDuration: document.createElement('span'),
      metaMic: document.createElement('span'),
      metaCamera: document.createElement('span'),

      // Shared
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
    // Uploading → the finalizing view is shown and config/recording are hidden,
    // so start/stop are simply not reachable (no per-control disabling needed).
    expect(elements.viewConfig.hidden).toBe(true);
    expect(elements.viewRecording.hidden).toBe(true);
    expect(elements.viewFinalizing.hidden).toBe(false);
    expect(elements.storageModeSelect.value).toBe('drive');
    expect(elements.micModeSelect.value).toBe('mixed');
    expect(elements.recordSelfVideoCheckbox.checked).toBe(true);
    expect(elements.finalizingLabel.textContent).toContain('Uploading to Google Drive');
    expect(elements.metaStorage.textContent).toBe('Google Drive');
    expect(elements.metaMic.textContent).toBe('Mixed');
    expect(elements.metaCamera.textContent).toBe('Separate');
    expect(elements.recordingStatusEl.textContent).toContain('Finalizing and saving files');
    expect(elements.recordingStatusEl.textContent).toContain('Mode: Drive');
  });

  it('renders a determinate upload ring from live upload progress', async () => {
    mockSendMessage.mockResolvedValueOnce({
      session: {
        phase: 'uploading',
        runConfig: { storageMode: 'drive', micMode: 'mixed', recordSelfVideo: false },
        uploadProgress: 0.42,
        updatedAt: Date.now(),
      },
    });
    controller.init();
    await new Promise(process.nextTick);

    expect(elements.uploadRing.dataset.mode).toBe('determinate');
    expect(elements.uploadRingLabel.textContent).toBe('42%');
    // The arc declares pathLength=100, so the offset is simply 100 − percent.
    expect(elements.uploadRingArc.style.strokeDashoffset).toBe('58');
  });

  it('keeps the upload ring indeterminate while finalizing without progress', async () => {
    mockSendMessage.mockResolvedValueOnce({
      session: {
        phase: 'stopping',
        runConfig: { storageMode: 'drive', micMode: 'mixed', recordSelfVideo: false },
        updatedAt: Date.now(),
      },
    });
    controller.init();
    await new Promise(process.nextTick);

    expect(elements.uploadRing.dataset.mode).toBe('indeterminate');
    expect(elements.uploadRingLabel.textContent).toBe('');
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
        tabContentType: 'screen',
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
        tabContentType: 'screen',
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

    expect(elements.viewConfig.hidden).toBe(true);
    expect(elements.viewFinalizing.hidden).toBe(false);
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

  const recordingSession = (extra: Record<string, unknown> = {}) => ({
    session: {
      phase: 'recording',
      runConfig: { storageMode: 'local', micMode: 'separate', recordSelfVideo: true },
      updatedAt: Date.now(),
      ...extra,
    },
  });

  describe('mic mute toggle (recording-view row)', () => {
    it('shows the mic row and mutes the mic on its pill', async () => {
      mockSendMessage.mockResolvedValueOnce(recordingSession());
      controller.init();
      await new Promise(process.nextTick);

      const pill = elements.muteMicBtn as HTMLButtonElement;
      const label = pill.querySelector('[data-mute-label]') as HTMLElement;
      expect(elements.micRow.hidden).toBe(false);
      expect(elements.micModeLabel.textContent).toBe('· separate');
      expect(label.textContent).toBe('on');
      expect(pill.classList.contains('on')).toBe(true);
      expect(pill.getAttribute('aria-pressed')).toBe('false');

      mockSendMessage.mockClear();
      mockSendMessage.mockResolvedValueOnce({ ok: true, ...recordingSession({ micMuted: true }) });
      pill.click();
      await new Promise(process.nextTick);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'SET_MIC_MUTED', muted: true });
      expect(label.textContent).toBe('off');
      expect(pill.classList.contains('off')).toBe(true);
      expect(pill.getAttribute('aria-pressed')).toBe('true');
    });

    it('hides the mic row when the recording has no microphone', async () => {
      mockSendMessage.mockResolvedValueOnce(recordingSession({
        runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: true },
      }));
      controller.init();
      await new Promise(process.nextTick);
      expect(elements.micRow.hidden).toBe(true);
    });
  });

  describe('hide-camera toggle (recording-view row)', () => {
    it('shows the camera row and hides the camera on its pill', async () => {
      mockSendMessage.mockResolvedValueOnce(recordingSession());
      controller.init();
      await new Promise(process.nextTick);

      const pill = elements.hideCameraBtn as HTMLButtonElement;
      const label = pill.querySelector('[data-camera-label]') as HTMLElement;
      expect(elements.cameraRow.hidden).toBe(false);
      expect(label.textContent).toBe('on');

      mockSendMessage.mockClear();
      mockSendMessage.mockResolvedValueOnce({ ok: true, ...recordingSession({ cameraMuted: true }) });
      pill.click();
      await new Promise(process.nextTick);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'SET_CAMERA_MUTED', muted: true });
      expect(label.textContent).toBe('off');
      expect(pill.classList.contains('off')).toBe(true);
      expect(pill.getAttribute('aria-pressed')).toBe('true');
    });

    it('hides the camera row when the recording has no camera', async () => {
      mockSendMessage.mockResolvedValueOnce(recordingSession({
        runConfig: { storageMode: 'local', micMode: 'separate', recordSelfVideo: false },
      }));
      controller.init();
      await new Promise(process.nextTick);
      expect(elements.cameraRow.hidden).toBe(true);
    });
  });

  describe('pause toggle (recording-view)', () => {
    it('enables Pause while recording and pauses the whole recording', async () => {
      mockSendMessage.mockResolvedValueOnce(recordingSession());
      controller.init();
      await new Promise(process.nextTick);

      const pill = elements.pauseBtn as HTMLButtonElement;
      const label = pill.querySelector('[data-pause-label]') as HTMLElement;
      expect(elements.viewRecording.hidden).toBe(false);
      expect(pill.disabled).toBe(false);
      expect(label.textContent).toBe('Pause');

      mockSendMessage.mockClear();
      mockSendMessage.mockResolvedValueOnce({ ok: true, ...recordingSession({ paused: true }) });
      pill.click();
      await new Promise(process.nextTick);

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'SET_PAUSED', paused: true });
      expect(label.textContent).toBe('Resume');
      expect(pill.getAttribute('aria-pressed')).toBe('true');
      expect(pill.classList.contains('btn-danger')).toBe(true);
    });

    it('reverts the toggle when the background rejects the pause', async () => {
      mockSendMessage.mockResolvedValueOnce(recordingSession());
      controller.init();
      await new Promise(process.nextTick);

      mockSendMessage.mockClear();
      mockSendMessage.mockResolvedValueOnce({ ok: false, error: 'pause boom' });
      elements.pauseBtn.click();
      await new Promise(process.nextTick);

      expect(elements.pauseBtn.disabled).toBe(false);
      expect(elements.pauseBtn.querySelector('[data-pause-label]').textContent).toBe('Pause');
    });

    it('does not show the recording view (or Pause) while finalizing', async () => {
      mockSendMessage.mockResolvedValueOnce(recordingSession({ phase: 'uploading' }));
      controller.init();
      await new Promise(process.nextTick);
      expect(elements.viewRecording.hidden).toBe(true);
      expect(elements.viewFinalizing.hidden).toBe(false);
    });
  });

  describe('recording banner + timer', () => {
    it('renders a pause-aware timer that ticks while recording and freezes when paused', async () => {
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      mockSendMessage.mockResolvedValueOnce(recordingSession({ recordedMs: 0, runningSince: now - 5000 }));
      controller.init();
      await new Promise(process.nextTick);

      expect(elements.recLabel.textContent).toBe('Recording');
      expect(elements.recBanner.classList.contains('paused')).toBe(false);
      expect(elements.recTimer.textContent).toBe('0:05');

      // Paused: timer frozen at the banked recordedMs (no running span).
      (controller as any).state.applySession(
        recordingSession({ paused: true, recordedMs: 65000, runningSince: undefined }).session
      );
      expect(elements.recLabel.textContent).toBe('Paused');
      expect(elements.recBanner.classList.contains('paused')).toBe(true);
      expect(elements.recTimer.textContent).toBe('1:05');
    });

    it('shows a Starting… banner during the starting phase', async () => {
      mockSendMessage.mockResolvedValueOnce(recordingSession({ phase: 'starting' }));
      controller.init();
      await new Promise(process.nextTick);
      expect(elements.recLabel.textContent).toBe('Starting…');
      expect(elements.pauseBtn.disabled).toBe(true);
    });
  });

  describe('live transcript chip', () => {
    it('reflects caption presence polled from the content script', async () => {
      mockTabSendMessage.mockImplementation(async (_tabId: number, message: { type: string }) => {
        if (message.type === 'GET_CAPTION_STATE') return { captionsActive: true };
        return { ok: true };
      });
      mockSendMessage.mockResolvedValueOnce(recordingSession());
      controller.init();
      await new Promise(process.nextTick);
      await new Promise(process.nextTick);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(101, { type: 'GET_CAPTION_STATE' });
      expect(elements.chipTranscriptLabel.textContent).toBe('Transcript on');
      expect(elements.chipTranscript.classList.contains('off')).toBe(false);
    });
  });

  describe('finalizing view metadata', () => {
    it('renders storage, duration, mic, and camera from the session', async () => {
      mockSendMessage.mockResolvedValueOnce({
        session: {
          phase: 'stopping',
          runConfig: { storageMode: 'local', micMode: 'separate', recordSelfVideo: true },
          recordedMs: 125000,
          updatedAt: Date.now(),
        },
      });
      controller.init();
      await new Promise(process.nextTick);

      expect(elements.viewFinalizing.hidden).toBe(false);
      expect(elements.finalizingLabel.textContent).toBe('Finalizing files…');
      expect(elements.metaStorage.textContent).toBe('Local Disk (OPFS)');
      expect(elements.metaDuration.textContent).toBe('2:05');
      expect(elements.metaMic.textContent).toBe('Separate');
      expect(elements.metaCamera.textContent).toBe('Separate');
    });
  });

});
