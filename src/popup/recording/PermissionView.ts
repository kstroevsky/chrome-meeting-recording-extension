/**
 * @file popup/PermissionView.ts
 *
 * The interstitial shown when a run needs microphone or camera access that the
 * browser has not granted yet.
 *
 * It has two shapes behind one render: *ask*, where the browser will prompt
 * once, and *blocked*, where it will not — the copy, both button labels and the
 * header tint all change together, so the screen never asks for something the
 * browser has already refused to ask for.
 *
 * Starting the recording is the caller's job; this view only reports which of
 * its two exits the user chose.
 */

import type { PopupPreviewPermissionState as PermissionQueryState } from './popupPreviewState';
import type { PopupElements } from './popupView';

export type PermissionElements = Pick<
  PopupElements,
  | 'viewConfig'
  | 'viewPermission'
  | 'viewRecording'
  | 'viewFinalizing'
  | 'viewUpload'
  | 'startBtn'
  | 'ppHeader'
  | 'permissionCopy'
  | 'permMicState'
  | 'permCameraState'
  | 'grantPermissionBtn'
  | 'permissionContinueBtn'
>;

export type PermissionActions = {
  /** The user asked for access. Resolves once the attempt has finished. */
  grant: () => Promise<void>;
  /** The user declined; the run continues without the camera. */
  skip: () => Promise<void>;
};

export class PermissionView {
  private readonly el: Partial<PermissionElements>;

  constructor(
    el: Partial<PermissionElements> | null | undefined,
    private readonly actions: PermissionActions,
  ) {
    this.el = el ?? {};
  }

  wire(): void {
    this.el.grantPermissionBtn?.addEventListener('click', () => void this.actions.grant());
    this.el.permissionContinueBtn?.addEventListener('click', () => void this.actions.skip());
  }

  /** Disables both exits while an attempt is in flight, so neither can double-fire. */
  setBusy(busy: boolean): void {
    if (this.el.grantPermissionBtn) this.el.grantPermissionBtn.disabled = busy;
    if (this.el.permissionContinueBtn) this.el.permissionContinueBtn.disabled = busy;
  }

  /** Shared renderer for real permission queries and preview fixtures. */
  render(micState: PermissionQueryState, cameraState: PermissionQueryState): void {
    if (this.el.viewConfig) this.el.viewConfig.hidden = true;
    if (this.el.viewPermission) this.el.viewPermission.hidden = false;
    if (this.el.viewRecording) this.el.viewRecording.hidden = true;
    if (this.el.viewFinalizing) this.el.viewFinalizing.hidden = true;
    if (this.el.viewUpload) this.el.viewUpload.hidden = true;
    if (this.el.startBtn) this.el.startBtn.disabled = false;

    this.renderState('mic', micState);
    this.renderState('camera', cameraState);

    // Blocked means the browser will not prompt again, so the screen stops
    // asking and starts explaining where the switch actually is.
    const blocked = micState === 'denied' || cameraState === 'denied';
    this.el.viewPermission?.classList.toggle('permission-blocked', blocked);
    this.el.ppHeader?.classList.toggle('permission-blocked', blocked);
    const title = document.getElementById('permission-title');
    const detail = document.getElementById('permission-detail');
    if (title) title.textContent = blocked ? 'Mic & camera blocked' : 'Allow mic & camera';
    if (detail) detail.textContent = blocked
      ? 'The browser is denying access on this site.'
      : 'Meet Recorder needs access to capture this tab. Your browser will ask once.';
    if (this.el.permissionCopy) this.el.permissionCopy.textContent = blocked
      ? 'Click the lock icon in the address bar → allow Microphone and Camera → reload.'
      : '';
    if (this.el.grantPermissionBtn) this.el.grantPermissionBtn.textContent = blocked ? 'Open site settings' : 'Allow access';
    if (this.el.permissionContinueBtn) this.el.permissionContinueBtn.textContent = blocked ? 'Try again' : 'Not now';
  }

  private renderState(kind: 'mic' | 'camera', state: PermissionQueryState): void {
    const el = kind === 'mic' ? this.el.permMicState : this.el.permCameraState;
    if (!el) return;
    const granted = state === 'granted';
    el.textContent = granted ? 'Granted' : state === 'denied' ? 'Blocked' : 'Needed';
    el.classList.toggle('ready', granted);
    el.classList.toggle('warn', !granted);

    const icon = this.el.viewPermission?.querySelector<HTMLElement>(
      kind === 'mic' ? '[data-perm-mic-icon]' : '[data-perm-camera-icon]'
    );
    icon?.classList.toggle('ready', granted);
    icon?.classList.toggle('warn', !granted);
  }
}
