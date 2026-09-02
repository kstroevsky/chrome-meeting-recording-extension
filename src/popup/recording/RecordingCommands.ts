/**
 * @file popup/recording/RecordingCommands.ts
 *
 * Starting, stopping and discarding a run — the three destructive-or-expensive
 * commands the popup can send, and the permission gate in front of the first.
 *
 * One lock guards all of them (`inFlight`), because they are not independent: a
 * discard that arrives while the start RPC is still settling would race the very
 * recording it is trying to destroy. Discard therefore *waits* for a start
 * rather than being dropped, and gives up with a message rather than guessing.
 *
 * Failure handling differs by command and is the reason they share a wrapper: a
 * failed start returns to setup, while a failed stop or discard re-reads
 * authoritative background state, because capture may well still be running.
 */

import type { CameraPermissionService } from './CameraPermissionService';
import type { ConfirmDialog } from '../ConfirmDialog';
import type { MicPermissionService } from './MicPermissionService';
import type { PermissionView } from './PermissionView';
import { formatDuration, formatPosition } from '../popupStatus';
import {
  buildDiscardConfirmMessage,
  buildDiscardErrorAlert,
  buildMicPermissionError,
  buildStartErrorAlert,
  buildStopErrorAlert,
  CAMERA_PERMISSION_ERROR,
  DISCARD_CONFIRM_TEXT,
  POPUP_TOAST_TEXT,
} from '../popupMessages';
import type { PopupElements } from '../popupView';
import { queryActiveTab } from '../../platform/chrome/tabs';
import { sendToBackground, sendToContent } from '../../shared/messages';
import { describeNotationForList, type RecordingNotation } from '../../shared/notations';
import type { RecordingRunConfig, RecordingStatusView } from '../../shared/recording';

/** A start held at the permission interstitial, waiting on the user's answer. */
type PendingStart = { tabId: number; runConfig: RecordingRunConfig };

/** How long Discard will wait for an in-flight start before giving up. */
const DISCARD_WAIT_MS = 3_000;

export type RecordingCommandsElements = Pick<PopupElements, 'startBtn' | 'stopBtn' | 'discardBtn' | 'recTimer'>;

export type RecordingCommandsActions = {
  notify: (message: string) => void;
  applySession: (session: RecordingStatusView) => void;
  /** The run config the setup form currently describes. */
  runConfigFromForm: () => RecordingRunConfig;
  /** Returns the popup to setup after a failed start. */
  resetToIdle: () => void;
  /** Re-reads authoritative state after a failed stop or discard. */
  refreshSession: () => Promise<void>;
  /** The active run's notes, so the discard prompt can name what goes with it. */
  activeNotations: () => RecordingNotation[];
};

export class RecordingCommands {
  private readonly el: Partial<RecordingCommandsElements>;
  private pendingStart: PendingStart | null = null;
  private inFlight = false;

  constructor(
    el: Partial<RecordingCommandsElements> | null | undefined,
    private readonly actions: RecordingCommandsActions,
    private readonly mic: MicPermissionService,
    private readonly camera: CameraPermissionService,
    private readonly permissionView: PermissionView,
    private readonly confirmDialog: ConfirmDialog,
  ) {
    this.el = el ?? {};
  }

  /** True while a command is in flight; the popup shows no other prompt then. */
  get busy(): boolean {
    return this.inFlight;
  }

  wire(): void {
    const { startBtn, stopBtn } = this.el;
    if (startBtn && stopBtn) {
      startBtn.addEventListener('click', () => this.execute(startBtn, 'START_RECORDING', () => this.start(), buildStartErrorAlert));
      stopBtn.addEventListener('click', () => this.execute(stopBtn, 'STOP_RECORDING', () => this.stop(), buildStopErrorAlert));
    }
    this.wireDiscard();
  }

  /** The permission interstitial's "allow" exit. */
  async grantCameraAndStart(): Promise<void> {
    await this.resumePendingStart(async (pending) => {
      const ok = await this.camera.ensureReadyForRecording();
      if (!ok) {
        await this.showPermission(pending);
        this.actions.notify(CAMERA_PERMISSION_ERROR);
        return false;
      }
      await this.begin(pending.tabId, pending.runConfig);
      return true;
    });
  }

  /** The permission interstitial's "not now" exit: the run drops the camera. */
  async continueWithoutCamera(): Promise<void> {
    await this.resumePendingStart(async (pending) => {
      await this.begin(pending.tabId, { ...pending.runConfig, recordSelfVideo: false });
      return true;
    });
  }

  /**
   * Discard destroys captured media with no undo, so it is gated behind an
   * in-popup confirmation. The prompt runs *before* the in-flight lock is taken:
   * a cancelled prompt must leave the popup exactly as it was, with the
   * recording still running and every control still live.
   */
  private wireDiscard(): void {
    const discardBtn = this.el.discardBtn;
    if (!discardBtn) return;
    discardBtn.addEventListener('click', async () => {
      if (this.confirmDialog.isOpen()) return;
      closePopupMenu();

      const notes = this.actions.activeNotations();
      const message = () =>
        buildDiscardConfirmMessage(this.el.recTimer?.textContent ?? undefined, notes.length);
      const confirmation = this.confirmDialog.ask({
        title: DISCARD_CONFIRM_TEXT.title,
        message: message(),
        confirmLabel: DISCARD_CONFIRM_TEXT.confirmLabel,
        cancelLabel: DISCARD_CONFIRM_TEXT.cancelLabel,
        tone: 'danger',
        details: notes.map((notation) => ({
          at: formatPosition(notation.tStartMs),
          text: describeNotationForList(notation, formatDuration),
        })),
      });
      // Recording continues behind the prompt; keep the amount to be discarded
      // truthful as the popup's live timer advances.
      const messageTimer = setInterval(() => this.confirmDialog.updateMessage(message()), 1_000);
      const confirmed = await confirmation;
      clearInterval(messageTimer);
      if (!confirmed) return;

      // A recording can become visible a few milliseconds before the start RPC
      // settles. Keep Discard responsive in that gap and then serialize the actual
      // destructive command behind the start command instead of dropping the click.
      const deadline = Date.now() + DISCARD_WAIT_MS;
      while (this.inFlight && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      if (this.inFlight) {
        this.actions.notify('Recording is still starting. Please try Discard again.');
        return;
      }

      await this.execute(discardBtn, 'DISCARD_RECORDING', () => this.discard(), buildDiscardErrorAlert);
    });
  }

  /**
   * Guards against concurrent commands and disables the button while the action
   * is in flight. A failed start returns to setup; failed stop/discard commands
   * re-read background state because capture may still be active.
   */
  private async execute(
    btn: HTMLButtonElement,
    label: string,
    action: () => Promise<void>,
    buildErrorAlert: (e: unknown) => string,
  ): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    btn.disabled = true;
    try {
      await action();
    } catch (e: unknown) {
      console.error(`[popup] ${label} error`, e);
      if (label === 'START_RECORDING') this.actions.resetToIdle();
      else await this.actions.refreshSession();
      alert(buildErrorAlert(e));
    } finally {
      this.inFlight = false;
    }
  }

  private async start(): Promise<void> {
    const tab = await queryActiveTab();
    if (!tab?.id) throw new Error('No active tab');

    await sendToContent(tab.id, { type: 'RESET_TRANSCRIPT' }).catch(() => {});

    const runConfig = this.actions.runConfigFromForm();
    const { micMode, recordSelfVideo } = runConfig;

    const micReady = await this.mic.ensureReadyForRecording(micMode);
    if (!micReady) throw new Error(buildMicPermissionError(micMode));

    if (recordSelfVideo) {
      const cameraState = await this.camera.queryCameraPermissionState();
      if (cameraState !== 'granted') {
        // Held here rather than failed: the interstitial's two exits resume it.
        await this.showPermission({ tabId: tab.id, runConfig }, cameraState);
        return;
      }
    }

    await this.begin(tab.id, runConfig);
  }

  private async begin(tabId: number, runConfig: RecordingRunConfig): Promise<void> {
    const resp = await sendToBackground({ type: 'START_RECORDING', tabId, runConfig });
    if (resp.ok === false) throw new Error(resp.error || 'Failed to start');
    this.actions.applySession(resp.session);
    this.actions.notify(POPUP_TOAST_TEXT.recordingStarted);
  }

  /** Raises the interstitial and remembers the start it is holding. */
  private async showPermission(
    pending: PendingStart,
    cameraState?: Awaited<ReturnType<CameraPermissionService['queryCameraPermissionState']>>,
  ): Promise<void> {
    this.pendingStart = pending;
    const [micState, resolvedCameraState] = await Promise.all([
      this.mic.queryMicPermissionState().catch(() => 'unknown' as const),
      cameraState ? Promise.resolve(cameraState) : this.camera.queryCameraPermissionState().catch(() => 'unknown' as const),
    ]);
    this.permissionView.render(micState, resolvedCameraState);
  }

  /** Shared body of the interstitial's two exits, including the busy handling. */
  private async resumePendingStart(run: (pending: PendingStart) => Promise<boolean>): Promise<void> {
    const pending = this.pendingStart;
    if (!pending || this.inFlight) return;
    this.inFlight = true;
    this.permissionView.setBusy(true);
    try {
      if (await run(pending)) this.pendingStart = null;
    } catch (e: unknown) {
      console.error('[popup] START_RECORDING error', e);
      this.actions.resetToIdle();
      alert(buildStartErrorAlert(e));
    } finally {
      this.inFlight = false;
      this.permissionView.setBusy(false);
    }
  }

  private async stop(): Promise<void> {
    const resp = await sendToBackground({ type: 'STOP_RECORDING' });
    if (resp.ok === false) throw new Error(resp.error || 'Failed to stop');
    this.actions.applySession(resp.session);
    this.actions.notify(POPUP_TOAST_TEXT.stopping);
  }

  /** Discards both media artifacts and the live caption buffer for this meeting tab. */
  private async discard(): Promise<void> {
    const tab = await queryActiveTab();
    const resp = await sendToBackground({ type: 'DISCARD_RECORDING' });
    if (resp.ok === false) throw new Error(resp.error || 'Failed to discard recording');

    // Captions are recording content too. Reset is best-effort because capture is
    // already being discarded by the background and the tab could close mid-click.
    if (tab?.id) await sendToContent(tab.id, { type: 'RESET_TRANSCRIPT' }).catch(() => {});
    this.actions.applySession(resp.session);
    this.actions.notify('Discarding recording and deleting captured media…');
  }
}

function closePopupMenu(): void {
  const menu = document.getElementById('popup-menu');
  if (menu) menu.hidden = true;
  document.getElementById('open-menu')?.setAttribute('aria-expanded', 'false');
}
