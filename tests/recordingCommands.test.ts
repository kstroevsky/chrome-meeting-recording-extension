jest.mock('../src/shared/settings', () => ({
  buildDefaultRunConfigFromSettings: jest.fn(),
  loadExtensionSettingsFromStorage: jest.fn(),
}));

jest.mock('../src/platform/chrome/tabs', () => ({
  sendTabMessage: jest.fn(),
}));

import {
  buildDefaultRunConfigFromSettings,
  loadExtensionSettingsFromStorage,
} from '../src/shared/settings';
import { sendTabMessage } from '../src/platform/chrome/tabs';
import {
  handleRecordingCommand,
  START_RECORDING_COMMAND,
} from '../src/background/recordingCommands';

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
});
