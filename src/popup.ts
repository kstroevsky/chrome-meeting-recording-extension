/**
 * @context  Extension Popup (browser_action page)
 * @role     Control Panel — start/stop recording, save transcript, manage mic permission.
 * @lifetime Created each time the user opens the popup; destroyed when it closes.
 *           Do NOT rely on state persisting here between opens.
 *
 * This file is intentionally thin: it reads DOM elements and hands them to
 * PopupController, which owns all interaction logic.
 *
 * Message flow:
 *   popup → background: START_RECORDING, STOP_RECORDING, GET_RECORDING_STATUS
 *   popup → content script: GET_TRANSCRIPT, RESET_TRANSCRIPT
 *   background → popup: RECORDING_STATE, RECORDING_SAVED
 *
 * @see src/popup/PopupController.ts   — all interaction logic
 * @see src/popup/MicPermissionService.ts — permission query + priming flow
 * @see src/shared/protocol.ts         — all message type definitions
 */
import { PopupController } from './popup/PopupController';

const controller = new PopupController({
  saveBtn: document.getElementById('save') as HTMLButtonElement | null,
  micBtn: document.getElementById('enable-mic') as HTMLButtonElement | null,
  micModeSelect: document.getElementById('mic-mode') as HTMLSelectElement | null,
  startBtn: document.getElementById('start-rec') as HTMLButtonElement | null,
  stopBtn: document.getElementById('stop-rec') as HTMLButtonElement | null,
  storageModeSelect: document.getElementById('storage-mode') as HTMLSelectElement | null,
  recordSelfVideoCheckbox: document.getElementById('record-self-video') as HTMLInputElement | null,
  selfVideoHighQualityCheckbox: document.getElementById('self-video-high-quality') as HTMLInputElement | null,
  openDiagnosticsBtn: document.getElementById('open-diagnostics') as HTMLButtonElement | null,
  recordingStatusEl: document.getElementById('recording-status') as HTMLElement | null,
});

controller.init();
