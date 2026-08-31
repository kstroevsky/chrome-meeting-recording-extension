/**
 * Keyboard-command entry point for recording without opening the action popup.
 * Chrome grants activeTab to commands invoked by the user, so this path keeps
 * tabCapture tied to the real shortcut gesture.
 */

import {
  buildDefaultRunConfigFromSettings,
  loadExtensionSettingsFromStorage,
} from '../shared/settings';
import { sendTabMessage } from '../platform/chrome/tabs';
import type { RecordingController } from './RecordingController';

export const START_RECORDING_COMMAND = 'start-recording';
export const MARK_NOTATION_COMMAND = 'mark-notation';

type RecordingCommandDeps = {
  controller: RecordingController;
  L: {
    log: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
};

export async function handleRecordingCommand(
  command: string,
  tab: chrome.tabs.Tab | undefined,
  { controller, L }: RecordingCommandDeps
): Promise<void> {
  // Marking targets the run, not a tab, so it needs neither an active tab nor
  // the activeTab grant that gates starting a recording.
  if (command === MARK_NOTATION_COMMAND) {
    const result = await controller.toggleNotation();
    if (!result.ok) L.warn('Mark note shortcut failed:', result.error);
    else L.log('Mark note shortcut', result.notation.tEndMs == null ? 'started' : 'ended', result.notation.id);
    return;
  }
  if (command !== START_RECORDING_COMMAND) return;
  if (!tab || typeof tab.id !== 'number') {
    L.warn('Start recording shortcut did not receive an active tab');
    return;
  }

  const settings = await loadExtensionSettingsFromStorage();
  const runConfig = buildDefaultRunConfigFromSettings(settings);
  await sendTabMessage(tab.id, { type: 'RESET_TRANSCRIPT' }).catch(() => {});

  const result = await controller.start({
    type: 'START_RECORDING',
    tabId: tab.id,
    runConfig,
  });
  if (!result.ok) {
    L.error('Start recording shortcut failed:', result.error);
    return;
  }
  L.log('Start recording shortcut accepted for tabId', tab.id);
}

export function registerRecordingCommands(deps: RecordingCommandDeps): void {
  chrome.commands.onCommand.addListener((command, tab) => {
    void handleRecordingCommand(command, tab, deps).catch((error) => {
      deps.L.error(
        `${command} shortcut failed unexpectedly:`,
        error instanceof Error ? error.message : String(error)
      );
    });
  });
}
