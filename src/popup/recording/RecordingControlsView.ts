/**
 * @file popup/RecordingControlsView.ts
 *
 * The three live controls on the recording screen: mute the microphone, hide
 * the camera, pause the whole run.
 *
 * All three share one rule, and it is the reason they live together: a toggle
 * never interrupts the capture. The button disables itself, the command goes
 * out, and the UI is repainted from the **session in the response** — so a
 * command the background rejects reverts on screen rather than lying about it.
 *
 * The mirrored `micMuted` / `cameraMuted` / `paused` flags are the last painted
 * state, which is what each toggle inverts. They are only ever assigned from a
 * session, never from a click.
 */

import type { PopupElements } from './popupView';
import type { CommandResult } from '../shared/protocol';
import type { RecordingPhase, RecordingStatusView } from '../shared/recording';

export type RecordingControlsElements = Pick<
  PopupElements,
  | 'micRow'
  | 'muteMicBtn'
  | 'micModeLabel'
  | 'micDeviceLabel'
  | 'micDeviceTrigger'
  | 'cameraRow'
  | 'hideCameraBtn'
  | 'cameraDeviceLabel'
  | 'cameraDeviceTrigger'
  | 'pauseBtn'
  | 'stopBtn'
>;

export type RecordingControlsActions = {
  setMicMuted: (muted: boolean) => Promise<CommandResult>;
  setCameraMuted: (muted: boolean) => Promise<CommandResult>;
  setPaused: (paused: boolean) => Promise<CommandResult>;
  /** Adopts the session a command answered with; the repaint follows from it. */
  applySession: (session: RecordingStatusView) => void;
  notify: (message: string) => void;
  text: {
    micMuted: string; micUnmuted: string;
    cameraHidden: string; cameraShown: string;
    recordingPaused: string; recordingResumed: string;
  };
};

export class RecordingControlsView {
  private readonly el: Partial<RecordingControlsElements>;
  private micMuted = false;
  private cameraMuted = false;
  private paused = false;

  constructor(
    el: Partial<RecordingControlsElements> | null | undefined,
    private readonly actions: RecordingControlsActions,
  ) {
    this.el = el ?? {};
  }

  wire(): void {
    this.el.muteMicBtn?.addEventListener('click', () => void this.toggleMic());
    this.el.hideCameraBtn?.addEventListener('click', () => void this.toggleCamera());
    this.el.pauseBtn?.addEventListener('click', () => void this.togglePause());
  }

  /** Repaints all three controls from the authoritative session. */
  sync(phase: RecordingPhase, session?: RecordingStatusView): void {
    this.syncMic(session);
    this.syncCamera(session);
    this.syncPause(phase, session);
  }

  /** Forgets the mirrored state when the run ends, so the next one starts clean. */
  reset(): void {
    this.micMuted = this.cameraMuted = this.paused = false;
  }

  private toggleMic(): Promise<void> {
    return this.run({
      btn: this.el.muteMicBtn,
      current: this.micMuted,
      send: (muted) => this.actions.setMicMuted(muted),
      toast: (next) => (next ? this.actions.text.micMuted : this.actions.text.micUnmuted),
      fallbackError: 'Failed to toggle microphone',
      logLabel: 'SET_MIC_MUTED',
    });
  }

  private toggleCamera(): Promise<void> {
    return this.run({
      btn: this.el.hideCameraBtn,
      current: this.cameraMuted,
      send: (muted) => this.actions.setCameraMuted(muted),
      toast: (next) => (next ? this.actions.text.cameraHidden : this.actions.text.cameraShown),
      fallbackError: 'Failed to toggle camera',
      logLabel: 'SET_CAMERA_MUTED',
    });
  }

  private togglePause(): Promise<void> {
    return this.run({
      btn: this.el.pauseBtn,
      current: this.paused,
      send: (paused) => this.actions.setPaused(paused),
      toast: (next) => (next ? this.actions.text.recordingPaused : this.actions.text.recordingResumed),
      fallbackError: 'Failed to pause recording',
      logLabel: 'SET_PAUSED',
    });
  }

  /**
   * The shared toggle path: disable, send, repaint from the response's session.
   * On failure only the button is restored — the painted state is never guessed.
   */
  private async run(opts: {
    btn: HTMLButtonElement | null | undefined;
    current: boolean;
    send: (next: boolean) => Promise<CommandResult>;
    toast: (next: boolean) => string;
    fallbackError: string;
    logLabel: string;
  }): Promise<void> {
    const { btn, current, send, toast, fallbackError, logLabel } = opts;
    if (!btn || btn.disabled) return;
    const next = !current;
    btn.disabled = true;
    try {
      const resp = await send(next);
      if (resp.ok === false) throw new Error(resp.error || fallbackError);
      this.actions.applySession(resp.session);
      this.actions.notify(toast(next));
    } catch (e: unknown) {
      console.error(`[popup] ${logLabel} error`, e);
      btn.disabled = false;
    }
  }

  /**
   * Shows the microphone row only when the run has a mic, and reflects the live
   * mute state on its on/off pill (a muted mic records silence).
   */
  private syncMic(session?: RecordingStatusView): void {
    const row = this.el.micRow;
    const btn = this.el.muteMicBtn;
    if (!row || !btn) return;

    const micMode = session?.runConfig?.micMode;
    const active = micMode === 'mixed' || micMode === 'separate';
    row.hidden = !active;
    if (!active) {
      this.micMuted = false;
      if (this.el.micDeviceTrigger) this.el.micDeviceTrigger.disabled = true;
      return;
    }

    if (this.el.micModeLabel) this.el.micModeLabel.textContent = micMode.toUpperCase();
    deviceLabel(this.el.micDeviceLabel, session?.capturedDevices?.microphone, 'microphone', session?.phase);
    if (this.el.micDeviceTrigger) this.el.micDeviceTrigger.disabled = session?.phase !== 'recording';
    this.micMuted = session?.micMuted === true;
    togglePill(btn, this.micMuted, '[data-mute-label]');
  }

  /**
   * Shows the camera row only when the run records the camera separately, and
   * reflects the live hidden state on its pill (hidden records black frames).
   */
  private syncCamera(session?: RecordingStatusView): void {
    const row = this.el.cameraRow;
    const btn = this.el.hideCameraBtn;
    if (!row || !btn) return;

    const active = session?.runConfig?.recordSelfVideo === true;
    row.hidden = !active;
    if (!active) {
      this.cameraMuted = false;
      if (this.el.cameraDeviceTrigger) this.el.cameraDeviceTrigger.disabled = true;
      return;
    }

    this.cameraMuted = session?.cameraMuted === true;
    deviceLabel(this.el.cameraDeviceLabel, session?.capturedDevices?.camera, 'camera', session?.phase);
    if (this.el.cameraDeviceTrigger) this.el.cameraDeviceTrigger.disabled = session?.phase !== 'recording';
    const cameraMode = document.getElementById('camera-mode-label');
    if (cameraMode) cameraMode.textContent = '720P';
    togglePill(btn, this.cameraMuted, '[data-camera-label]');
  }

  /**
   * Reflects pause state on the Pause/Resume button. Enabled only once actively
   * recording (disabled during the brief `starting` phase).
   */
  private syncPause(phase: RecordingPhase, session?: RecordingStatusView): void {
    const btn = this.el.pauseBtn;
    if (!btn) return;

    const recording = phase === 'recording';
    btn.disabled = !recording;
    this.paused = recording && session?.paused === true;
    btn.setAttribute('aria-pressed', String(this.paused));
    btn.classList.toggle('btn-primary', this.paused);
    btn.classList.toggle('btn-secondary', !this.paused);
    btn.classList.remove('btn-danger');
    const label = btn.querySelector<HTMLElement>('[data-pause-label]') ?? btn;
    label.textContent = this.paused ? 'Resume Recording' : 'Pause';
    const icon = btn.querySelector('svg');
    if (icon) {
      icon.innerHTML = this.paused
        ? '<path d="M3 2l7 4-7 4V2z"/>'
        : '<rect x="1" y="1" width="3.4" height="12" rx="1"/><rect x="7.6" y="1" width="3.4" height="12" rx="1"/>';
      icon.setAttribute('viewBox', this.paused ? '0 0 12 12' : '0 0 12 14');
    }
    document.querySelector('.controls')?.classList.toggle('paused', this.paused);
    const stopLabel = this.el.stopBtn?.querySelector<HTMLElement>('[data-stop-label]');
    if (stopLabel) stopLabel.textContent = this.paused ? 'Stop & Save' : 'Finish Recording';
    document.getElementById('paused-meta')?.toggleAttribute('hidden', !this.paused);
  }
}

/**
 * Renders an on/off pill button (the mic-mute and camera-hide rows share this).
 * `muted` is the "off" state: the pill reads "off"/`aria-pressed=true` when muted.
 */
function togglePill(btn: HTMLButtonElement, muted: boolean, labelSelector: string): void {
  btn.disabled = false;
  btn.setAttribute('aria-pressed', String(muted));
  btn.classList.toggle('on', !muted);
  btn.classList.toggle('off', muted);
  const label = btn.querySelector<HTMLElement>(labelSelector) ?? btn;
  label.textContent = muted ? 'off' : 'on';
}

/** The label Chrome exposed for the active track, without claiming it was explicitly chosen. */
function deviceLabel(
  el: HTMLElement | null | undefined,
  label: string | undefined,
  device: 'microphone' | 'camera',
  phase: RecordingPhase | undefined,
): void {
  if (!el) return;
  const text = label || (phase === 'starting' ? 'Connecting…' : `${device === 'microphone' ? 'Microphone' : 'Camera'} unavailable`);
  el.textContent = text;
  el.title = label ? `Current ${device}: ${label}` : text;
}
