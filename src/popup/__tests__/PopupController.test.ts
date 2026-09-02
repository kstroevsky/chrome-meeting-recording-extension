import { CameraPermissionService } from '../recording/CameraPermissionService';
import { MicPermissionService } from '../recording/MicPermissionService';
import { PopupController } from '../PopupController';
import { DEFAULT_EXTENSION_SETTINGS } from '../../shared/settings';
import type { RecordingRunConfig } from '../../shared/recording';

jest.mock('../recording/MicPermissionService');
jest.mock('../recording/CameraPermissionService');

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Answers the in-popup discard confirmation, then drains the command it releases. */
const confirmDiscard = async () => {
  await flush();
  document.querySelector<HTMLButtonElement>('[data-confirm-accept]')!.click();
  await flush();
};

/** Pushes a background RECORDING_STATE into the controller's runtime listener. */
const emitRecordingState = (session: Record<string, unknown>) => {
  const calls = (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls;
  calls[calls.length - 1][0]({ type: 'RECORDING_STATE', session });
};

describe('PopupController', () => {
  let controller: PopupController;
  let elements: any;
  let mockSendMessage: jest.Mock;
  let mockTabsQuery: jest.Mock;
  let mockTabSendMessage: jest.Mock;

  beforeEach(() => {
    // The popup caches its last phase in localStorage for the synchronous first paint;
    // clear it so one test's phase can't leak into another's optimistic initial view.
    localStorage.clear();
    jest.clearAllMocks();
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
      tabContentTypeGroup: document.createElement('div'),
      openSettingsBtn: document.createElement('button'),
      openDiagnosticsBtn: document.createElement('button'),
      cameraWarning: document.createElement('div'),
      cameraWarningText: document.createElement('span'),

      // View containers
      viewConfig: document.createElement('section'),
      viewPermission: document.createElement('section'),
      viewRecording: document.createElement('section'),
      viewFinalizing: document.createElement('section'),

      // Permission interstitial
      permMicState: document.createElement('span'),
      permCameraState: document.createElement('span'),
      permissionCopy: document.createElement('p'),
      grantPermissionBtn: document.createElement('button'),
      permissionContinueBtn: document.createElement('button'),

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
      micDeviceLabel: document.createElement('span'),
      micDeviceTrigger: document.createElement('button'),
      micMeterBars: Array.from({ length: 7 }, () => document.createElement('span')),
      muteMicBtn: pill('data-mute-label'),
      cameraRow: document.createElement('div'),
      cameraDeviceLabel: document.createElement('span'),
      cameraDeviceTrigger: document.createElement('button'),
      hideCameraBtn: pill('data-camera-label'),
      devicePicker: document.createElement('div'),
      devicePickerTitle: document.createElement('span'),
      devicePickerList: document.createElement('div'),
      devicePickerError: document.createElement('div'),
      devicePickerTrack: document.createElement('span'),
      devicePickerMode: document.createElement('span'),
      devicePickerClose: document.createElement('button'),
      pauseBtn: pill('data-pause-label'),
      stopBtn: document.createElement('button'),
      discardBtn: document.createElement('button'),
      tabSourceSub: document.createElement('div'),

      // Finalizing view
      finalizingLabel: document.createElement('div'),
      uploadRing: document.createElement('div'),
      uploadRingArc: document.createElement('div'),
      uploadRingLabel: document.createElement('span'),
      metaStorage: document.createElement('span'),
      metaDuration: document.createElement('span'),
      metaMic: document.createElement('span'),
      metaCamera: document.createElement('span'),
      finalizingSub: document.createElement('div'),
      finalizingFiles: document.createElement('ul'),

      // Session tabs + per-job upload view
      sessionTabs: document.createElement('nav'),
      viewUpload: document.createElement('section'),
      uploadProgress: document.createElement('div'),
      uploadDone: document.createElement('div'),
      uploadJobLabel: document.createElement('div'),
      uploadJobPct: document.createElement('span'),
      uploadBarFill: document.createElement('div'),
      uploadJobMeta: document.createElement('div'),
      uploadJobSub: document.createElement('div'),
      uploadJobFiles: document.createElement('ul'),
      uploadJobOpenDrive: document.createElement('button'),
      uploadJobRetry: document.createElement('button'),

    };
    elements.recordSelfVideoCheckbox.type = 'checkbox';
    elements.devicePicker.hidden = true;
    const pickerScrim = document.createElement('button');
    pickerScrim.setAttribute('data-device-picker-dismiss', '');
    elements.devicePicker.append(pickerScrim, elements.devicePickerList);
    (navigator.mediaDevices as any).enumerateDevices = jest.fn().mockResolvedValue([]);

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
    (CameraPermissionService.prototype.queryCameraPermissionState as jest.Mock).mockResolvedValue('granted');
    (MicPermissionService.prototype.ensureReadyForRecording as jest.Mock).mockResolvedValue(true);
    (MicPermissionService.prototype.queryMicPermissionState as jest.Mock).mockResolvedValue('granted');

    controller = new PopupController(elements);

    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(window, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers(); // never let a fake-timer test leak into the next
    controller.destroy();
    (globalThis as any).__DEV_BUILD__ = false;
    jest.restoreAllMocks();
  });

  it('paints the cached phase synchronously on open so it never flashes Setup', async () => {
    // Simulate a popup reopened during a recording: the last render cached 'recording'.
    localStorage.setItem('meetRecorder.lastPhase', 'recording');
    mockSendMessage.mockResolvedValueOnce({ session: { phase: 'recording', runConfig: null, updatedAt: Date.now() } });

    controller.init();
    // BEFORE the async status fetch resolves, the recording view is already shown and
    // the Setup/config view is hidden — no flash.
    expect(elements.viewRecording.hidden).toBe(false);
    expect(elements.viewConfig.hidden).toBe(true);

    await new Promise(process.nextTick); // fetch confirms it; still recording
    expect(elements.viewRecording.hidden).toBe(false);
  });

  it('defaults the synchronous first paint to Setup when no phase is cached', () => {
    controller.init(); // no localStorage cache → idle → config
    expect(elements.viewConfig.hidden).toBe(false);
    expect(elements.viewRecording.hidden).toBe(true);
  });

  it('opens the naming modal when a Drive upload completes and applies the renamed session', async () => {
    controller.init();
    await flush();
    const completed = {
      id: 'job-1', historyId: 'recording:1', label: 'google-meet-demo-20260815T1200',
      status: 'completed', progress: 1, namingStatus: 'pending', startedAt: 1, finishedAt: 2,
      driveFolderId: 'folder-1', driveFolderName: 'google-meet-demo-20260815T1200',
      files: [{ stream: 'tab', filename: 'google-meet-demo-20260815T1200-recording.webm', status: 'uploaded', driveFileId: 'file-1' }],
    };
    mockSendMessage.mockImplementation(async (message: any) => {
      if (message.type === 'RENAME_RECORDING_HISTORY') return {
        ok: true,
        entry: {
          id: 'recording:1', name: 'Quarterly Review', userNamed: true, createdAt: 1,
          storageMode: 'drive', status: 'complete', driveFolderId: 'folder-1', driveFolderName: 'quarterly-review',
          files: [{ id: 'recording:1:tab', stream: 'tab', filename: 'quarterly-review-recording.webm', destination: 'drive', status: 'available', driveFileId: 'file-1' }],
        },
        session: { phase: 'idle', runConfig: null, uploadJobs: [{ ...completed, label: 'Quarterly Review', namingStatus: 'named', driveFolderName: 'quarterly-review', files: [{ ...completed.files[0], filename: 'quarterly-review-recording.webm' }] }], updatedAt: 3 },
      };
      return { session: { phase: 'idle', runConfig: null, updatedAt: 3 } };
    });

    emitRecordingState({ phase: 'idle', runConfig: null, uploadJobs: [completed], updatedAt: 2 });
    await flush();

    const nameInput = document.querySelector<HTMLInputElement>('.recording-name-input')!;
    expect(nameInput.value).toBe('google-meet-demo-20260815T1200');
    expect(elements.viewUpload.hidden).toBe(false);
    nameInput.value = 'Quarterly Review';
    document.querySelector<HTMLButtonElement>('[data-recording-name-save]')!.click();
    await flush();

    expect(mockSendMessage).toHaveBeenCalledWith({
      type: 'RENAME_RECORDING_HISTORY', id: 'recording:1', name: 'Quarterly Review',
    });
    expect(document.querySelector<HTMLElement>('.recording-name-overlay')!.hidden).toBe(true);
    expect(elements.uploadJobFiles.textContent).toContain('quarterly-review-recording.webm');
  });

  it('reuses the naming modal for a later local recording rename', async () => {
    const entry = {
      id: 'recording:local', name: 'Original title', createdAt: 1, storageMode: 'local', status: 'complete',
      files: [{ id: 'recording:local:tab', stream: 'tab', filename: 'original-recording.webm', destination: 'local', status: 'available', downloadId: 9 }],
    };
    mockSendMessage.mockImplementation(async (message: any) => message.type === 'RENAME_RECORDING_HISTORY'
      ? { ok: true, entry: { ...entry, name: message.name, userNamed: true } }
      : { session: { phase: 'idle', runConfig: null, updatedAt: 1 } });
    // The detail screen owns the recording on view; this test is about the name
    // dialog it reuses, so it drives that view directly rather than the DOM.
    const detail = (controller as any).detail;
    detail.current = { kind: 'recording', entry };

    const rename = detail.startRename();
    await flush();
    const input = document.querySelector<HTMLInputElement>('.recording-name-input')!;
    expect(input.value).toBe('Original title');
    expect(document.querySelector('.recording-name-card')?.textContent).toContain('history');
    input.value = 'New display title';
    document.querySelector<HTMLButtonElement>('[data-recording-name-save]')!.click();
    await rename;
    await flush();

    expect(mockSendMessage).toHaveBeenCalledWith({
      type: 'RENAME_RECORDING_HISTORY', id: 'recording:local', name: 'New display title',
    });
    expect(detail.target.entry.files[0].filename).toBe('original-recording.webm');
  });

  it('defers completed-upload naming during an active recording and opens it once idle', async () => {
    controller.init();
    await flush();
    const completed = {
      id: 'job-1', historyId: 'recording:1', label: 'Default recording', status: 'completed', progress: 1,
      namingStatus: 'pending', startedAt: 1, finishedAt: 2,
      files: [{ stream: 'tab', filename: 'default-recording.webm', status: 'uploaded', driveFileId: 'file-1' }],
    };

    emitRecordingState({ phase: 'recording', runConfig: (global as any).__TEST_RUN_CONFIG__(), uploadJobs: [completed], updatedAt: 2 });
    await flush();
    expect(document.querySelector('.recording-name-overlay')).toBeNull();

    emitRecordingState({ phase: 'idle', runConfig: null, uploadJobs: [completed], updatedAt: 3 });
    await flush();
    expect(document.querySelector<HTMLElement>('.recording-name-overlay')!.hidden).toBe(false);
  });

  it('restores a pending naming prompt from the initial persisted session', async () => {
    mockSendMessage.mockResolvedValueOnce({
      session: {
        phase: 'idle', runConfig: null, updatedAt: 2,
        uploadJobs: [{
          id: 'job-1', historyId: 'recording:1', label: 'Persisted recording', status: 'completed', progress: 1,
          namingStatus: 'pending', startedAt: 1, finishedAt: 2,
          files: [{ stream: 'tab', filename: 'persisted-recording.webm', status: 'uploaded', driveFileId: 'file-1' }],
        }],
      },
    });

    controller.init();
    await flush();

    expect(document.querySelector<HTMLInputElement>('.recording-name-input')?.value).toBe('Persisted recording');
    expect(document.querySelector<HTMLElement>('.recording-name-overlay')?.hidden).toBe(false);
  });

  it('persists Skip and does not reopen the automatic naming modal', async () => {
    controller.init();
    await flush();
    const completed = {
      id: 'job-1', historyId: 'recording:1', label: 'Default recording', status: 'completed', progress: 1,
      namingStatus: 'pending', startedAt: 1, finishedAt: 2,
      files: [{ stream: 'tab', filename: 'default-recording.webm', status: 'uploaded', driveFileId: 'file-1' }],
    };
    const skipped = { ...completed, namingStatus: 'skipped' };
    mockSendMessage.mockImplementation(async (message: any) => message.type === 'SKIP_RECORDING_NAMING'
      ? { ok: true, session: { phase: 'idle', runConfig: null, uploadJobs: [skipped], updatedAt: 3 } }
      : { session: { phase: 'idle', runConfig: null, updatedAt: 1 } });

    emitRecordingState({ phase: 'idle', runConfig: null, uploadJobs: [completed], updatedAt: 2 });
    await flush();
    document.querySelector<HTMLButtonElement>('[data-recording-name-cancel]')!.click();
    await flush();

    expect(mockSendMessage).toHaveBeenCalledWith({ type: 'SKIP_RECORDING_NAMING', jobId: 'job-1' });
    emitRecordingState({ phase: 'idle', runConfig: null, uploadJobs: [skipped], updatedAt: 4 });
    await flush();
    expect(document.querySelector<HTMLElement>('.recording-name-overlay')!.hidden).toBe(true);
  });

  it('queues multiple completed recordings and opens the next prompt after Skip', async () => {
    controller.init();
    await flush();
    const makeCompleted = (id: string, label: string, finishedAt: number) => ({
      id, historyId: `recording:${id}`, label, status: 'completed', progress: 1,
      namingStatus: 'pending', startedAt: 1, finishedAt,
      files: [{ stream: 'tab', filename: `${id}.webm`, status: 'uploaded', driveFileId: `file-${id}` }],
    });
    const first = makeCompleted('one', 'First recording', 2);
    const second = makeCompleted('two', 'Second recording', 3);
    mockSendMessage.mockImplementation(async (message: any) => message.type === 'SKIP_RECORDING_NAMING'
      ? {
          ok: true,
          session: {
            phase: 'idle', runConfig: null, updatedAt: 4,
            uploadJobs: [{ ...first, namingStatus: 'skipped' }, second],
          },
        }
      : { session: { phase: 'idle', runConfig: null, updatedAt: 1 } });

    emitRecordingState({ phase: 'idle', runConfig: null, uploadJobs: [second, first], updatedAt: 3 });
    await flush();
    expect(document.querySelector<HTMLInputElement>('.recording-name-input')!.value).toBe('First recording');

    document.querySelector<HTMLButtonElement>('[data-recording-name-cancel]')!.click();
    await flush();
    expect(document.querySelector<HTMLInputElement>('.recording-name-input')!.value).toBe('Second recording');
    expect(document.querySelector<HTMLElement>('.recording-name-overlay')!.hidden).toBe(false);
  });

  it('renders a deterministic preview through the same recording renderer', () => {
    controller.renderPreview({
      screen: 'session',
      session: {
        phase: 'recording',
        runConfig: {
          storageMode: 'drive',
          micMode: 'separate',
          recordSelfVideo: true,
          tabContentType: 'screen',
        },
        recordedMs: 754_000,
        paused: true,
        micMuted: true,
        cameraMuted: true,
        tabResolution: { height: 1080 },
        capturedDevices: {
          microphone: 'MacBook Pro Microphone',
          camera: 'FaceTime HD Camera',
        },
        updatedAt: 0,
      },
      transcriptActive: true,
    });

    expect(elements.viewRecording.hidden).toBe(false);
    expect(elements.viewConfig.hidden).toBe(true);
    expect(elements.recLabel.textContent).toBe('Paused');
    expect(elements.recTimer.textContent).toBe('00:12:34');
    expect(elements.chipStorageLabel.textContent).toBe('Google Drive');
    expect(elements.micDeviceLabel.textContent).toBe('MacBook Pro Microphone');
    expect(elements.cameraDeviceLabel.textContent).toBe('FaceTime HD Camera');
    expect(elements.chipTranscriptLabel.textContent).toBe('Transcribing');
  });

  it('shows the camera resolution warning when separate camera capture uses a sub-1080p preset', async () => {
    (chrome.storage.local.get as jest.Mock).mockResolvedValueOnce({
      extensionSettings: {
        ...DEFAULT_EXTENSION_SETTINGS,
        basic: {
          ...DEFAULT_EXTENSION_SETTINGS.basic,
          separateCameraCapture: true,
          selfVideoResolutionPreset: '1280x720',
        },
      },
    });
    mockSendMessage.mockResolvedValueOnce({
      session: { phase: 'idle', runConfig: null, updatedAt: Date.now() },
    });

    controller.init();
    await new Promise(process.nextTick);

    expect(elements.recordSelfVideoCheckbox.checked).toBe(true);
    expect(elements.cameraWarning.hidden).toBe(false);
    expect(elements.cameraWarningText.textContent).toBe('Camera delivering 720p · raise in settings');

    elements.recordSelfVideoCheckbox.checked = false;
    elements.recordSelfVideoCheckbox.dispatchEvent(new Event('change'));
    expect(elements.cameraWarning.hidden).toBe(true);
  });

  it('initializes UI correctly from an existing stopping state', async () => {
    mockSendMessage.mockResolvedValueOnce({
      session: {
        phase: 'stopping',
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
    // Stopping → the finalizing view is shown and config/recording are hidden,
    // so start/stop are simply not reachable (no per-control disabling needed).
    expect(elements.viewConfig.hidden).toBe(true);
    expect(elements.viewRecording.hidden).toBe(true);
    expect(elements.viewFinalizing.hidden).toBe(false);
    expect(elements.storageModeSelect.value).toBe('drive');
    expect(elements.micModeSelect.value).toBe('mixed');
    expect(elements.recordSelfVideoCheckbox.checked).toBe(true);
    expect(elements.finalizingLabel.textContent).toBe('Finalizing recording');
    expect(elements.finalizingSub.textContent).toBe('Muxing tab & camera'); // mixed mic → no separate mic file
    expect(elements.finalizingFiles.querySelectorAll('li')).toHaveLength(2);
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

  describe('session tabs + background uploads (ADR-0004)', () => {
    const sessionWith = (uploadJobs: unknown[], phase = 'idle') => ({
      session: { phase, runConfig: null, uploadJobs, updatedAt: Date.now() },
    });
    const job = (over: Record<string, unknown> = {}) => ({
      id: 'j1',
      label: 'meet-abc',
      status: 'uploading',
      progress: 0.42,
      files: [{ stream: 'tab', filename: 'tab.webm', status: 'uploading' }],
      startedAt: 1,
      ...over,
    });

    it('hides the tab bar when there are no background uploads', async () => {
      controller.init(); // default mock: idle, no uploadJobs
      await new Promise(process.nextTick);
      expect(elements.sessionTabs.hidden).toBe(true);
    });

    it('renders the upload tabs first with the live tab as the end anchor', async () => {
      mockSendMessage.mockResolvedValueOnce(sessionWith([job()]));
      controller.init();
      await new Promise(process.nextTick);

      expect(elements.sessionTabs.hidden).toBe(false);
      const tabs = elements.sessionTabs.querySelectorAll('.session-tab');
      expect(tabs).toHaveLength(2);
      // Order: [upload job, …, live]. The live end-anchor is the "＋ New" action.
      expect(tabs[0].textContent).toContain('meet-abc');
      expect(tabs[0].textContent).toContain('42%');
      expect(tabs[1].textContent).toContain('New');
      expect(tabs[1].classList.contains('session-tab--new')).toBe(true);
      expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    });

    it('switches to a determinate per-job upload view when its tab is clicked', async () => {
      mockSendMessage.mockResolvedValueOnce(sessionWith([job()]));
      controller.init();
      await new Promise(process.nextTick);

      (elements.sessionTabs.querySelectorAll('.session-tab')[0] as HTMLButtonElement).click();

      expect(elements.viewUpload.hidden).toBe(false);
      expect(elements.viewConfig.hidden).toBe(true);
      expect(elements.uploadJobPct.textContent).toBe('42%');
      expect(elements.uploadBarFill.style.width).toBe('42%');
      expect(elements.uploadProgress.hidden).toBe(false);
      expect(elements.uploadDone.hidden).toBe(true);
      expect(elements.uploadJobLabel.textContent).toBe('to Google Drive');
      expect(elements.uploadJobFiles.children).toHaveLength(1);
      // An in-flight upload tab has no × close affordance.
      expect(elements.sessionTabs.querySelector('.session-tab-close')).toBeNull();
    });

    it('shows a done state and clears a finished upload via its tab ×', async () => {
      mockSendMessage.mockResolvedValueOnce(
        sessionWith([job({ status: 'completed', progress: 1, files: [{ stream: 'tab', filename: 'tab.webm', status: 'uploaded' }], finishedAt: 2 })])
      );
      controller.init();
      await new Promise(process.nextTick);

      (elements.sessionTabs.querySelectorAll('.session-tab')[0] as HTMLButtonElement).click();
      expect(elements.uploadDone.hidden).toBe(false);
      expect(elements.uploadProgress.hidden).toBe(true);

      // Re-query after the select re-rendered the bar; the finished tab carries a ×.
      const close = elements.sessionTabs.querySelector('.session-tab-close') as HTMLElement;
      expect(close).not.toBeNull();
      mockSendMessage.mockResolvedValueOnce({ session: { phase: 'idle', runConfig: null, updatedAt: Date.now() } });
      close.click();
      await new Promise(process.nextTick);

      expect(mockSendMessage).toHaveBeenCalledWith({ type: 'DISMISS_UPLOAD_JOB', jobId: 'j1' });
      expect(elements.viewUpload.hidden).toBe(true);
      expect(elements.sessionTabs.hidden).toBe(true); // bar gone with the last job
    });

    it('keeps Setup selected when another upload begins', async () => {
      // First render already has an upload (simulates a reopen mid-upload) → Setup.
      mockSendMessage.mockResolvedValueOnce(sessionWith([job()]));
      controller.init();
      await new Promise(process.nextTick);
      expect(elements.viewUpload.hidden).toBe(true);
      expect(elements.viewConfig.hidden).toBe(false);

      // A later push introduces another job. The header upload control is now the
      // explicit navigation affordance, so Setup stays usable for another recording.
      (controller as unknown as { state: { applySession: (s: unknown) => void } }).state.applySession({
        phase: 'idle', runConfig: null, updatedAt: Date.now(), uploadJobs: [job(), job({ id: 'j2', label: 'new-mtg', progress: 0.1 })],
      });

      expect(elements.viewUpload.hidden).toBe(true);
      expect(elements.viewConfig.hidden).toBe(false);
    });

    it('the ＋ New tab leaves the upload screen for Setup', async () => {
      mockSendMessage.mockResolvedValueOnce(sessionWith([job()]));
      controller.init();
      await new Promise(process.nextTick);

      (elements.sessionTabs.querySelectorAll('.session-tab')[0] as HTMLButtonElement).click();
      expect(elements.viewUpload.hidden).toBe(false);

      (elements.sessionTabs.querySelector('.session-tab[data-tab="live"]') as HTMLButtonElement).click();
      expect(elements.viewUpload.hidden).toBe(true);
      expect(elements.viewConfig.hidden).toBe(false); // back on Setup; the upload keeps running
      expect(elements.sessionTabs.hidden).toBe(false); // its tab is still there
    });

    it('exposes tablist semantics with a roving tabindex', async () => {
      mockSendMessage.mockResolvedValueOnce(sessionWith([job()]));
      controller.init();
      await new Promise(process.nextTick);

      const tabs = Array.from(elements.sessionTabs.querySelectorAll('.session-tab')) as HTMLButtonElement[];
      expect(elements.sessionTabs.getAttribute('role')).toBe('tablist');
      expect(tabs.every((t) => t.getAttribute('role') === 'tab')).toBe(true);
      // Order [job, live]; live is selected → tabindex 0, the job tab → -1.
      expect(tabs[0].tabIndex).toBe(-1);
      expect(tabs[1].tabIndex).toBe(0);
    });

    it('navigates tabs with the arrow keys', async () => {
      mockSendMessage.mockResolvedValueOnce(sessionWith([job()]));
      controller.init();
      await new Promise(process.nextTick);

      // Live (last) is selected; ArrowRight wraps to the first (job) tab and activates it.
      elements.sessionTabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      expect(elements.viewUpload.hidden).toBe(false);
      expect(elements.uploadJobLabel.textContent).toBe('to Google Drive');
    });

    it('dismisses a focused finished tab with the Delete key', async () => {
      mockSendMessage.mockResolvedValueOnce(sessionWith([job({ status: 'completed', progress: 1 })]));
      controller.init();
      await new Promise(process.nextTick);
      mockSendMessage.mockClear();
      mockSendMessage.mockResolvedValueOnce({ session: { phase: 'idle', runConfig: null, updatedAt: Date.now() } });

      const jobTab = elements.sessionTabs.querySelector('.session-tab[data-status="completed"]') as HTMLButtonElement;
      jobTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      await new Promise(process.nextTick);

      expect(mockSendMessage).toHaveBeenCalledWith({ type: 'DISMISS_UPLOAD_JOB', jobId: 'j1' });
    });

    it('offers Retry for a failed upload and sends RETRY_UPLOAD_JOB', async () => {
      mockSendMessage.mockResolvedValueOnce(
        sessionWith([job({ status: 'failed', progress: 1, files: [{ stream: 'tab', filename: 'tab.webm', status: 'fallback' }], finishedAt: 2 })])
      );
      controller.init();
      await new Promise(process.nextTick);

      (elements.sessionTabs.querySelectorAll('.session-tab')[0] as HTMLButtonElement).click();
      expect(elements.uploadJobRetry.hidden).toBe(false);
      expect(elements.uploadJobLabel.textContent).toContain('Upload failed');

      mockSendMessage.mockClear();
      mockSendMessage.mockResolvedValueOnce({ ok: true, session: { phase: 'idle', runConfig: null, updatedAt: Date.now() } });
      elements.uploadJobRetry.click();
      await new Promise(process.nextTick);

      expect(mockSendMessage).toHaveBeenCalledWith({ type: 'RETRY_UPLOAD_JOB', jobId: 'j1' });
    });

    it('hides Retry for a completed upload', async () => {
      mockSendMessage.mockResolvedValueOnce(sessionWith([job({ status: 'completed', progress: 1, finishedAt: 2 })]));
      controller.init();
      await new Promise(process.nextTick);

      (elements.sessionTabs.querySelectorAll('.session-tab')[0] as HTMLButtonElement).click();
      expect(elements.uploadJobRetry.hidden).toBe(true);
    });

    it('logs when a retry is no longer possible', async () => {
      mockSendMessage.mockResolvedValueOnce(
        sessionWith([job({ status: 'failed', progress: 1, files: [{ stream: 'tab', filename: 'tab.webm', status: 'fallback' }], finishedAt: 2 })])
      );
      controller.init();
      await new Promise(process.nextTick);
      (elements.sessionTabs.querySelectorAll('.session-tab')[0] as HTMLButtonElement).click();

      mockSendMessage.mockResolvedValueOnce({ ok: false, error: 'This upload can no longer be retried' });
      elements.uploadJobRetry.click();
      await new Promise(process.nextTick);

      expect(console.log).toHaveBeenCalledWith('[popup]', expect.stringContaining('no longer be retried'));
    });

    it('auto-dismisses a completed tab after it lingers', async () => {
      jest.useFakeTimers();
      mockSendMessage.mockResolvedValueOnce(sessionWith([job({ status: 'completed', progress: 1 })]));
      controller.init();
      await jest.advanceTimersByTimeAsync(0); // flush the initial status fetch
      mockSendMessage.mockClear(); // forget the status fetch (and any prior test's calls)

      expect(mockSendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'DISMISS_UPLOAD_JOB' }));
      await jest.advanceTimersByTimeAsync(10_000 + 300); // linger + fade
      expect(mockSendMessage).toHaveBeenCalledWith({ type: 'DISMISS_UPLOAD_JOB', jobId: 'j1' });
    });

    it('keeps a partial/failed tab (it needs attention) past the linger', async () => {
      jest.useFakeTimers();
      mockSendMessage.mockResolvedValueOnce(sessionWith([job({ status: 'partial', progress: 1 })]));
      controller.init();
      await jest.advanceTimersByTimeAsync(0);
      mockSendMessage.mockClear();

      await jest.advanceTimersByTimeAsync(10_000 + 300);
      expect(mockSendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'DISMISS_UPLOAD_JOB' }));
    });
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

  it('shows the permission interstitial instead of starting when camera permission is needed', async () => {
    (CameraPermissionService.prototype.queryCameraPermissionState as jest.Mock).mockResolvedValue('prompt');
    (MicPermissionService.prototype.queryMicPermissionState as jest.Mock).mockResolvedValue('granted');
    controller.init();
    await flush();
    mockSendMessage.mockClear();
    (chrome.tabs.sendMessage as jest.Mock).mockClear();

    elements.storageModeSelect.value = 'drive';
    elements.micModeSelect.value = 'mixed';
    elements.recordSelfVideoCheckbox.checked = true;

    elements.startBtn.click();
    await flush();

    expect(elements.viewPermission.hidden).toBe(false);
    expect(elements.viewConfig.hidden).toBe(true);
    expect(elements.permMicState.textContent).toBe('Granted');
    expect(elements.permCameraState.textContent).toBe('Needed');
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(101, { type: 'RESET_TRANSCRIPT' });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'START_RECORDING' }));
    expect(elements.startBtn.disabled).toBe(false);
  });

  it('grants camera permission from the interstitial and starts with self video still enabled', async () => {
    (CameraPermissionService.prototype.queryCameraPermissionState as jest.Mock).mockResolvedValue('prompt');
    controller.init();
    await flush();
    mockSendMessage.mockClear();
    elements.storageModeSelect.value = 'local';
    elements.micModeSelect.value = 'mixed';
    elements.recordSelfVideoCheckbox.checked = true;

    elements.startBtn.click();
    await flush();
    mockSendMessage.mockResolvedValueOnce({
      ok: true,
      session: {
        phase: 'recording',
        runConfig: (global as any).__TEST_RUN_CONFIG__({ micMode: 'mixed', recordSelfVideo: true }),
        updatedAt: Date.now(),
      },
    });

    elements.grantPermissionBtn.click();
    await flush();

    expect(CameraPermissionService.prototype.ensureReadyForRecording).toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      tabId: 101,
      runConfig: {
        storageMode: 'local',
        micMode: 'mixed',
        recordSelfVideo: true,
        tabContentType: 'screen',
      },
    });
    expect(elements.viewPermission.hidden).toBe(true);
    expect(elements.viewRecording.hidden).toBe(false);
  });

  it('keeps the permission interstitial visible when camera grant fails', async () => {
    (CameraPermissionService.prototype.queryCameraPermissionState as jest.Mock).mockResolvedValue('prompt');
    (CameraPermissionService.prototype.ensureReadyForRecording as jest.Mock).mockResolvedValue(false);
    controller.init();
    await flush();
    mockSendMessage.mockClear();
    elements.recordSelfVideoCheckbox.checked = true;

    elements.startBtn.click();
    await flush();
    elements.grantPermissionBtn.click();
    await flush();

    expect(elements.viewPermission.hidden).toBe(false);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'START_RECORDING' }));
    expect(elements.permCameraState.textContent).toBe('Needed');
    expect(elements.grantPermissionBtn.disabled).toBe(false);
    expect(elements.permissionContinueBtn.disabled).toBe(false);
  });

  it('continues from the permission interstitial with self video forced off', async () => {
    (CameraPermissionService.prototype.queryCameraPermissionState as jest.Mock).mockResolvedValue('prompt');
    controller.init();
    await flush();
    mockSendMessage.mockClear();
    elements.storageModeSelect.value = 'drive';
    elements.micModeSelect.value = 'separate';
    elements.recordSelfVideoCheckbox.checked = true;

    elements.startBtn.click();
    await flush();
    mockSendMessage.mockResolvedValueOnce({
      ok: true,
      session: {
        phase: 'recording',
        runConfig: (global as any).__TEST_RUN_CONFIG__({
          storageMode: 'drive',
          micMode: 'separate',
          recordSelfVideo: false,
        }),
        updatedAt: Date.now(),
      },
    });

    elements.permissionContinueBtn.click();
    await flush();

    expect(CameraPermissionService.prototype.ensureReadyForRecording).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      tabId: 101,
      runConfig: {
        storageMode: 'drive',
        micMode: 'separate',
        recordSelfVideo: false,
        tabContentType: 'screen',
      },
    });
    expect(elements.viewPermission.hidden).toBe(true);
    expect(elements.viewRecording.hidden).toBe(false);
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

  it('renders the real tab capture resolution when the session provides it', async () => {
    controller.init();
    await new Promise(process.nextTick);

    (controller as any).state.applySession({
      phase: 'recording',
      runConfig: (global as any).__TEST_RUN_CONFIG__({ tabContentType: 'video' }),
      tabResolution: { width: 1920, height: 1080 },
      updatedAt: Date.now(),
    });

    expect(elements.tabSourceSub.textContent).toBe('Video · 1080p');
  });

  it('keeps the tab source label content-only when real height is unavailable', async () => {
    controller.init();
    await new Promise(process.nextTick);

    (controller as any).state.applySession({
      phase: 'recording',
      runConfig: (global as any).__TEST_RUN_CONFIG__({ tabContentType: 'screen' }),
      updatedAt: Date.now(),
    });

    expect(elements.tabSourceSub.textContent).toBe('Screen');
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

  it('handles DISCARD_RECORDING click and clears the active tab transcript', async () => {
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
    elements.discardBtn.click();
    await confirmDiscard();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'DISCARD_RECORDING' });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(101, { type: 'RESET_TRANSCRIPT' });
    expect(console.log).toHaveBeenCalledWith('[popup]', expect.stringContaining('Discarding recording'));
  });

  it('asks before discarding and sends nothing when the confirmation is cancelled', async () => {
    mockSendMessage.mockResolvedValueOnce(recordingSession());
    controller.init();
    await flush();

    mockSendMessage.mockClear();
    elements.discardBtn.click();
    await flush();

    const message = document.querySelector('.modal-message')?.textContent ?? '';
    expect(message).toContain("You'll lose");
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>('[data-confirm-cancel]')!.click();
    await flush();

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('.modal-overlay')!.hidden).toBe(true);
    expect(elements.viewRecording.hidden).toBe(false);
    expect(elements.discardBtn.disabled).toBe(false);
  });

  it('retracts an open discard prompt when the recording ends on its own', async () => {
    mockSendMessage.mockResolvedValueOnce(recordingSession());
    controller.init();
    await flush();

    elements.discardBtn.click();
    await flush();
    expect(document.querySelector<HTMLElement>('.modal-overlay')!.hidden).toBe(false);

    emitRecordingState({ phase: 'idle', runConfig: (global as any).__TEST_RUN_CONFIG__(), updatedAt: Date.now() });
    await flush();

    expect(document.querySelector<HTMLElement>('.modal-overlay')!.hidden).toBe(true);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ type: 'DISCARD_RECORDING' });
  });

  it('keeps the recording view and explains stale runtime code when discard gets no response', async () => {
    mockSendMessage.mockResolvedValueOnce(recordingSession());
    controller.init();
    await flush();

    mockSendMessage
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(recordingSession());
    elements.discardBtn.click();
    await confirmDiscard();

    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('background runtime did not respond'));
    expect(window.alert).toHaveBeenCalledWith(expect.stringContaining('Reload the unpacked extension'));
    expect(elements.viewRecording.hidden).toBe(false);
    expect(elements.viewConfig.hidden).toBe(true);
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
        phase: 'stopping',
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

  it('skips the download when the transcript is empty', async () => {
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

    expect(console.log).toHaveBeenCalledWith('[popup]', expect.stringContaining('Transcript is empty'));
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

  it('logs the saved-locally confirmation on RECORDING_SAVED', async () => {
    controller.init();
    await new Promise(process.nextTick);

    currentRuntimeListener()({ type: 'RECORDING_SAVED', filename: 'tab.webm' });

    expect(console.log).toHaveBeenCalledWith('[popup]', expect.stringContaining('Saved locally: tab.webm'));
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
    it('shows the labels of the microphone and camera Chrome opened for this recording', async () => {
      mockSendMessage.mockResolvedValueOnce(recordingSession({
        capturedDevices: { microphone: 'Shure MV7', camera: 'Logitech Brio' },
      }));
      controller.init();
      await new Promise(process.nextTick);

      expect(elements.micDeviceLabel.textContent).toBe('Shure MV7');
      expect(elements.micDeviceLabel.title).toBe('Current microphone: Shure MV7');
      expect(elements.cameraDeviceLabel.textContent).toBe('Logitech Brio');
      expect(elements.cameraDeviceLabel.title).toBe('Current camera: Logitech Brio');
    });

    it('lists live microphones in the device sheet and changes the recording input in place', async () => {
      (navigator.mediaDevices.enumerateDevices as jest.Mock).mockResolvedValue([
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Shure MV7' },
        { kind: 'videoinput', deviceId: 'cam-1', label: 'Logitech Brio' },
        { kind: 'audioinput', deviceId: 'mic-2', label: 'AirPods Pro' },
      ]);
      mockSendMessage.mockResolvedValueOnce(recordingSession({
        capturedDevices: { microphone: 'Shure MV7', camera: 'Logitech Brio' },
      }));
      controller.init();
      await flush();

      elements.micDeviceTrigger.click();
      await flush();

      expect(elements.devicePicker.hidden).toBe(false);
      expect(elements.devicePickerTitle.textContent).toBe('MICROPHONE');
      expect(elements.devicePickerTrack.textContent).toBe('Audio track');
      expect(elements.devicePickerMode.textContent).toBe('SEPARATE');
      const options = (elements.devicePickerList as HTMLElement)
        .querySelectorAll<HTMLButtonElement>('.device-picker-option');
      expect(options).toHaveLength(2);
      expect(options[0].textContent).toContain('Shure MV7');
      expect(options[0].getAttribute('aria-selected')).toBe('true');
      expect(options[1].textContent).toContain('AirPods Pro');

      mockSendMessage.mockClear();
      mockSendMessage.mockResolvedValueOnce({
        ok: true,
        ...recordingSession({ capturedDevices: { microphone: 'AirPods Pro', camera: 'Logitech Brio' } }),
      });
      options[1].click();
      await flush();

      expect(mockSendMessage).toHaveBeenCalledWith({
        type: 'SET_INPUT_DEVICE',
        device: 'microphone',
        deviceId: 'mic-2',
      });
      expect(elements.micDeviceLabel.textContent).toBe('AirPods Pro');
      expect(elements.devicePicker.hidden).toBe(true);
    });

    it('hides Chrome’s duplicate default microphone alias when the same physical input is listed', async () => {
      (navigator.mediaDevices.enumerateDevices as jest.Mock).mockResolvedValue([
        { kind: 'audioinput', deviceId: 'default', label: 'Default - MacBook Pro Microphone (Built-in)' },
        { kind: 'audioinput', deviceId: 'mic-built-in', label: 'MacBook Pro Microphone (Built-in)' },
        { kind: 'audioinput', deviceId: 'mic-airpods', label: 'AirPods Pro' },
      ]);
      mockSendMessage.mockResolvedValueOnce(recordingSession({
        capturedDevices: { microphone: 'MacBook Pro Microphone (Built-in)' },
      }));
      controller.init();
      await flush();

      elements.micDeviceTrigger.click();
      await flush();

      const options = Array.from((elements.devicePickerList as HTMLElement)
        .querySelectorAll<HTMLButtonElement>('.device-picker-option'));
      expect(options).toHaveLength(2);
      expect(options.map((option) => option.dataset.deviceId)).toEqual(['mic-built-in', 'mic-airpods']);
      expect(options.map((option) => option.textContent)).not.toContain(expect.stringContaining('Default -'));
    });

    it('retains a standalone system-default microphone when Chrome has no matching physical input', async () => {
      (navigator.mediaDevices.enumerateDevices as jest.Mock).mockResolvedValue([
        { kind: 'audioinput', deviceId: 'default', label: 'Default - MacBook Pro Microphone (Built-in)' },
      ]);
      mockSendMessage.mockResolvedValueOnce(recordingSession({
        capturedDevices: { microphone: 'MacBook Pro Microphone (Built-in)' },
      }));
      controller.init();
      await flush();

      elements.micDeviceTrigger.click();
      await flush();

      const option = (elements.devicePickerList as HTMLElement)
        .querySelector<HTMLButtonElement>('.device-picker-option')!;
      expect(option.dataset.deviceId).toBe('default');
      expect(option.textContent).toContain('System default — MacBook Pro Microphone (Built-in)');
      expect(option.getAttribute('aria-selected')).toBe('true');
    });

    it('shows only cameras in the camera device sheet', async () => {
      (navigator.mediaDevices.enumerateDevices as jest.Mock).mockResolvedValue([
        { kind: 'audioinput', deviceId: 'mic-1', label: 'Shure MV7' },
        { kind: 'videoinput', deviceId: 'cam-1', label: 'Logitech Brio' },
        { kind: 'videoinput', deviceId: 'cam-2', label: 'FaceTime HD Camera' },
      ]);
      mockSendMessage.mockResolvedValueOnce(recordingSession({
        capturedDevices: { microphone: 'Shure MV7', camera: 'Logitech Brio' },
      }));
      controller.init();
      await flush();

      elements.cameraDeviceTrigger.click();
      await flush();

      expect(elements.devicePickerTitle.textContent).toBe('CAMERA');
      expect(elements.devicePickerTrack.textContent).toBe('Video track');
      expect(elements.devicePickerMode.textContent).toBe('720P');
      const options = (elements.devicePickerList as HTMLElement)
        .querySelectorAll<HTMLButtonElement>('.device-picker-option');
      expect(options).toHaveLength(2);
      expect(Array.from(options).map((option) => option.textContent)).toEqual([
        expect.stringContaining('Logitech Brio'),
        expect.stringContaining('FaceTime HD Camera'),
      ]);
    });

    it('shows the mic row and mutes the mic on its pill', async () => {
      mockSendMessage.mockResolvedValueOnce(recordingSession());
      controller.init();
      await new Promise(process.nextTick);

      const pill = elements.muteMicBtn as HTMLButtonElement;
      const label = pill.querySelector('[data-mute-label]') as HTMLElement;
      expect(elements.micRow.hidden).toBe(false);
      expect(elements.micModeLabel.textContent).toBe('SEPARATE');
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

  it('renders the meeting tab source from the run config content type', async () => {
    mockSendMessage.mockResolvedValueOnce(recordingSession({
      runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false, tabContentType: 'video' },
    }));
    controller.init();
    await new Promise(process.nextTick);
    expect(elements.tabSourceSub.textContent).toBe('Video');
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
      expect(label.textContent).toBe('Resume Recording');
      expect(pill.getAttribute('aria-pressed')).toBe('true');
      expect(pill.classList.contains('btn-primary')).toBe(true);
      expect(pill.classList.contains('btn-danger')).toBe(false);
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
      mockSendMessage.mockResolvedValueOnce(recordingSession({ phase: 'stopping' }));
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

      expect(elements.recLabel.textContent).toBe('REC');
      expect(elements.recBanner.classList.contains('paused')).toBe(false);
      expect(elements.recTimer.textContent).toBe('00:00:05');

      // Paused: timer frozen at the banked recordedMs (no running span).
      (controller as any).state.applySession(
        recordingSession({ paused: true, recordedMs: 65000, runningSince: undefined }).session
      );
      expect(elements.recLabel.textContent).toBe('Paused');
      expect(elements.recBanner.classList.contains('paused')).toBe(true);
      expect(elements.recTimer.textContent).toBe('00:01:05');
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
      expect(elements.chipTranscriptLabel.textContent).toBe('Transcribing');
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
      expect(elements.finalizingLabel.textContent).toBe('Finalizing recording');
      expect(elements.finalizingSub.textContent).toBe('Muxing tab, mic & camera');
      expect(elements.finalizingFiles.querySelectorAll('li')).toHaveLength(3);
    });
  });

});
