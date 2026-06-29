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
 *   popup → content script: GET_TRANSCRIPT, RESET_TRANSCRIPT, GET_CAPTION_STATE
 *   background → popup: RECORDING_STATE, RECORDING_SAVED
 *
 * @see src/popup/PopupController.ts   — all interaction logic
 * @see src/popup/MicPermissionService.ts — permission query + priming flow
 * @see src/shared/protocol.ts         — all message type definitions
 */
import { PopupController } from './popup/PopupController';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const controller = new PopupController({
  // Header + config view
  saveBtn: byId<HTMLButtonElement>('save'),
  micBtn: byId<HTMLButtonElement>('enable-mic'),
  micModeSelect: byId<HTMLSelectElement>('mic-mode'),
  startBtn: byId<HTMLButtonElement>('start-rec'),
  storageModeSelect: byId<HTMLSelectElement>('storage-mode'),
  recordSelfVideoCheckbox: byId<HTMLInputElement>('record-self-video'),
  tabContentTypeGroup: byId('tab-content-type'),
  openSettingsBtn: byId<HTMLButtonElement>('open-settings'),
  openDiagnosticsBtn: byId<HTMLButtonElement>('open-diagnostics'),

  // View containers
  viewConfig: byId('view-config'),
  viewRecording: byId('view-recording'),
  viewFinalizing: byId('view-finalizing'),

  // Recording view
  recBanner: byId('rec-banner'),
  recLabel: byId('rec-label'),
  recTimer: byId('rec-timer'),
  chipTranscript: byId('chip-transcript'),
  chipTranscriptLabel: byId('chip-transcript-label'),
  chipStorage: byId('chip-storage'),
  chipStorageLabel: byId('chip-storage-label'),
  micRow: byId('row-mic'),
  micModeLabel: byId('mic-mode-label'),
  muteMicBtn: byId<HTMLButtonElement>('mute-mic'),
  cameraRow: byId('row-camera'),
  hideCameraBtn: byId<HTMLButtonElement>('hide-camera'),
  pauseBtn: byId<HTMLButtonElement>('pause-recording'),
  stopBtn: byId<HTMLButtonElement>('stop-rec'),

  // Finalizing view
  finalizingLabel: byId('finalizing-label'),
  uploadRing: byId('upload-ring'),
  uploadRingArc: byId('upload-ring-arc'),
  uploadRingLabel: byId('upload-ring-label'),
  metaStorage: byId('meta-storage'),
  metaDuration: byId('meta-duration'),
  metaMic: byId('meta-mic'),
  metaCamera: byId('meta-camera'),

  // Session tabs + per-job upload view
  sessionTabs: byId('session-tabs'),
  viewUpload: byId('view-upload'),
  uploadJobRing: byId('upload-job-ring'),
  uploadJobRingArc: byId('upload-job-ring-arc'),
  uploadJobRingLabel: byId('upload-job-ring-label'),
  uploadJobLabel: byId('upload-job-label'),
  uploadJobFiles: byId('upload-job-files'),
  uploadJobNew: byId<HTMLButtonElement>('upload-job-new'),
  uploadJobDismiss: byId<HTMLButtonElement>('upload-job-dismiss'),

  // Shared status / toast line
  recordingStatusEl: byId('recording-status'),
});

controller.init();
