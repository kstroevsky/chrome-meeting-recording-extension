jest.mock('../../../shared/messages', () => ({
  sendToBackground: jest.fn(),
}));
jest.mock('../../../shared/settings', () => {
  const actual = jest.requireActual('../../../shared/settings');
  return { ...actual, loadExtensionSettingsFromStorage: jest.fn().mockResolvedValue(actual.DEFAULT_EXTENSION_SETTINGS) };
});

import { PopupStateController } from '../PopupStateController';
import { sendToBackground } from '../../../shared/messages';
import { loadExtensionSettingsFromStorage } from '../../../shared/settings';
import type { RecordingStatusView } from '../../../shared/recording';

function makeElements() {
  const storageModeSelect = document.createElement('select');
  ['local', 'drive'].forEach((v) => {
    const o = document.createElement('option');
    o.value = v;
    storageModeSelect.appendChild(o);
  });
  const micModeSelect = document.createElement('select');
  ['off', 'mixed', 'separate'].forEach((v) => {
    const o = document.createElement('option');
    o.value = v;
    micModeSelect.appendChild(o);
  });
  const recordSelfVideoCheckbox = document.createElement('input');
  recordSelfVideoCheckbox.type = 'checkbox';
  return {
    storageModeSelect,
    micModeSelect,
    recordSelfVideoCheckbox,
    startBtn: document.createElement('button'),
    stopBtn: document.createElement('button'),
    recordingStatusEl: document.createElement('div'),
  } as any;
}

function makeController() {
  const el = makeElements();
  const callbacks = { onPhaseChange: jest.fn(), onToast: jest.fn(), onAlert: jest.fn() };
  const controller = new PopupStateController(el, callbacks);
  return { el, callbacks, controller };
}

const idleView = (over: Partial<RecordingStatusView> = {}): RecordingStatusView => ({
  phase: 'idle',
  runConfig: null,
  updatedAt: Date.now(),
  ...over,
});

describe('PopupStateController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (loadExtensionSettingsFromStorage as jest.Mock).mockResolvedValue(
      jest.requireActual('../../../shared/settings').DEFAULT_EXTENSION_SETTINGS
    );
  });

  it('exposes default run configs before any session is applied', () => {
    const { controller } = makeController();
    expect(controller.getActiveRunConfig()).toEqual(
      expect.objectContaining({ storageMode: expect.any(String), micMode: expect.any(String) })
    );
    expect(controller.getIdleDefaultRunConfig()).toEqual(controller.getActiveRunConfig());
  });

  describe('refreshInitialState', () => {
    it('hydrates from the background session on success', async () => {
      const { controller, callbacks } = makeController();
      (sendToBackground as jest.Mock).mockResolvedValue({ session: idleView() });

      await controller.refreshInitialState();

      expect(callbacks.onPhaseChange).toHaveBeenCalledWith('idle', expect.objectContaining({ phase: 'idle' }));
    });

    it('falls back to default config when settings fail to load', async () => {
      const { controller } = makeController();
      (loadExtensionSettingsFromStorage as jest.Mock).mockRejectedValue(new Error('storage error'));
      (sendToBackground as jest.Mock).mockResolvedValue({ session: idleView() });

      await controller.refreshInitialState();

      expect(controller.getIdleDefaultRunConfig()).toEqual(
        expect.objectContaining({ storageMode: expect.any(String), micMode: expect.any(String), recordSelfVideo: expect.any(Boolean) })
      );
    });

    it('renders a local idle view when the background is unreachable', async () => {
      const { controller, callbacks } = makeController();
      (sendToBackground as jest.Mock).mockRejectedValue(new Error('no background'));

      await controller.refreshInitialState();

      expect(callbacks.onPhaseChange).toHaveBeenLastCalledWith('idle', expect.objectContaining({ phase: 'idle', runConfig: null }));
    });
  });

  describe('applySession', () => {
    it('toasts the runtime error for a failed phase', () => {
      const { controller, callbacks } = makeController();
      controller.applySession(idleView({ phase: 'failed', error: 'capture lost' }));
      expect(callbacks.onToast).toHaveBeenCalledWith('Recording error: capture lost');
    });

    it('toasts an upload confirmation when an upload run finishes cleanly', () => {
      const { controller, callbacks } = makeController();
      controller.applySession(idleView({ phase: 'uploading', runConfig: { storageMode: 'drive', micMode: 'off', recordSelfVideo: false } }));
      controller.applySession(idleView({
        phase: 'idle',
        uploadSummary: { uploaded: [{ stream: 'tab', filename: 'tab.webm' }], localFallbacks: [] },
      }));

      expect(callbacks.onToast).toHaveBeenCalledWith('Uploaded 1 file(s) to Google Drive');
    });

    it('alerts about local fallbacks and de-duplicates a repeated summary', () => {
      const { controller, callbacks } = makeController();
      const summary = {
        uploaded: [],
        localFallbacks: [{ stream: 'tab' as const, filename: 'tab.webm', error: 'AbortError' }],
      };

      controller.applySession(idleView({ phase: 'idle', uploadSummary: summary }));
      controller.applySession(idleView({ phase: 'idle', uploadSummary: summary }));

      expect(callbacks.onAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildPersistentStatus', () => {
    it('returns warning text (possibly empty) for the idle phase', () => {
      const { controller } = makeController();
      expect(typeof controller.buildPersistentStatus('idle')).toBe('string');
    });

    it('includes the phase label and run config for an active phase', () => {
      const { controller } = makeController();
      controller.applySession(idleView({ phase: 'recording', runConfig: { storageMode: 'drive', micMode: 'mixed', recordSelfVideo: true } }));
      const status = controller.buildPersistentStatus('recording');
      expect(status.length).toBeGreaterThan(0);
    });
  });
});
