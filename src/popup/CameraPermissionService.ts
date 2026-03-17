/**
 * @file popup/CameraPermissionService.ts
 *
 * Popup-side camera permission helper used when self-video capture is enabled.
 */

import { createRuntimeTab } from '../platform/chrome/tabs';

export class CameraPermissionService {
  /** Opens the dedicated runtime page that can trigger Chrome's camera permission UI. */
  async openCameraSetupTab() {
    await createRuntimeTab('camsetup.html');
  }

  /** Reads Chrome's current camera permission state for the extension origin. */
  async queryCameraPermissionState(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
    if (!('permissions' in navigator)) return 'unknown';

    try {
      const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
      return (status?.state as any) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Tries to grant camera access inline from the popup when Chrome allows it. */
  async tryPrimeInline(): Promise<boolean> {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      s.getTracks().forEach((t) => t.stop());
      return true;
    } catch {
      return false;
    }
  }

  /** Ensures camera permission is ready before a recording that includes self-video starts. */
  async ensureReadyForRecording(): Promise<boolean> {
    const state = await this.queryCameraPermissionState();
    if (state === 'granted') return true;
    if (state === 'denied') {
      await this.openCameraSetupTab();
      return false;
    }

    const ok = await this.tryPrimeInline().catch(() => false);
    if (ok) return true;

    await this.openCameraSetupTab();
    return false;
  }
}
