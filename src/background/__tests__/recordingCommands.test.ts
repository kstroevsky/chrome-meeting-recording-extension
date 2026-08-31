jest.mock('../../shared/settings', () => ({
  buildDefaultRunConfigFromSettings: jest.fn(),
  loadExtensionSettingsFromStorage: jest.fn(),
}));

jest.mock('../../platform/chrome/tabs', () => ({
  sendTabMessage: jest.fn(),
}));

import {
  buildDefaultRunConfigFromSettings,
  loadExtensionSettingsFromStorage,
} from '../../shared/settings';
import { sendTabMessage } from '../../platform/chrome/tabs';
import {
  handleRecordingCommand,
  MARK_NOTATION_COMMAND,
  START_RECORDING_COMMAND,
} from '../recordingCommands';

describe('recording keyboard command', () => {
  const settings = {
    basic: {
      recordingMode: 'opfs',
      microphoneRecordingMode: 'separate',
      separateCameraCapture: true,
      selfVideoResolutionPreset: '640x360',
    },
    professional: {},
  };
  const runConfig = {
    storageMode: 'local',
    micMode: 'separate',
    recordSelfVideo: true,
  } as const;

  beforeEach(() => {
    jest.clearAllMocks();
    (loadExtensionSettingsFromStorage as jest.Mock).mockResolvedValue(settings);
    (buildDefaultRunConfigFromSettings as jest.Mock).mockReturnValue(runConfig);
    (sendTabMessage as jest.Mock).mockResolvedValue({ ok: true });
  });

  it('starts the active tab using the persisted popup defaults', async () => {
    const controller = {
      start: jest.fn().mockResolvedValue({
        ok: true,
        session: { phase: 'starting' },
      }),
    };
    const L = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    await handleRecordingCommand(
      START_RECORDING_COMMAND,
      { id: 42, url: 'https://meet.google.com/abc-defg-hij' } as chrome.tabs.Tab,
      { controller: controller as any, L }
    );

    expect(loadExtensionSettingsFromStorage).toHaveBeenCalledTimes(1);
    expect(buildDefaultRunConfigFromSettings).toHaveBeenCalledWith(settings);
    expect(sendTabMessage).toHaveBeenCalledWith(42, { type: 'RESET_TRANSCRIPT' });
    expect(controller.start).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      tabId: 42,
      runConfig,
    });
    expect(L.error).not.toHaveBeenCalled();
  });

  it('ignores unrelated commands and reports a missing active tab', async () => {
    const controller = { start: jest.fn() };
    const L = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    await handleRecordingCommand(
      'unrelated',
      { id: 42 } as chrome.tabs.Tab,
      { controller: controller as any, L }
    );
    await handleRecordingCommand(
      START_RECORDING_COMMAND,
      {} as chrome.tabs.Tab,
      { controller: controller as any, L }
    );

    expect(controller.start).not.toHaveBeenCalled();
    expect(L.warn).toHaveBeenCalledWith(
      'Start recording shortcut did not receive an active tab'
    );
  });

  describe('mark note shortcut (⌥M, ADR-0005)', () => {
    const L = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() });

    it('toggles a note without needing an active tab', async () => {
      const controller = {
        toggleNotation: jest.fn().mockResolvedValue({
          ok: true,
          notation: { id: 'notation:1', tStartMs: 5_000, text: '' },
        }),
      };
      const log = L();

      // Chrome hands commands a tab, but marking must not depend on one.
      await handleRecordingCommand(MARK_NOTATION_COMMAND, undefined, { controller: controller as any, L: log });

      expect(controller.toggleNotation).toHaveBeenCalledTimes(1);
      expect(loadExtensionSettingsFromStorage).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    });

    it('warns rather than throwing when there is no recording to mark', async () => {
      const controller = {
        toggleNotation: jest.fn().mockResolvedValue({
          ok: false,
          error: 'Mark requested but no recording is active',
        }),
      };
      const log = L();

      await handleRecordingCommand(MARK_NOTATION_COMMAND, undefined, { controller: controller as any, L: log });

      expect(log.warn).toHaveBeenCalledWith(
        'Mark note shortcut failed:',
        'Mark requested but no recording is active',
      );
      expect(log.error).not.toHaveBeenCalled();
    });

    it('never starts a recording', async () => {
      const controller = {
        toggleNotation: jest.fn().mockResolvedValue({ ok: true, notation: { id: 'n', tStartMs: 0, text: '' } }),
        start: jest.fn(),
      };

      await handleRecordingCommand(MARK_NOTATION_COMMAND, undefined, { controller: controller as any, L: L() });

      expect(controller.start).not.toHaveBeenCalled();
    });
  });
});
