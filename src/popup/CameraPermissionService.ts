export class CameraPermissionService {
  async openCameraSetupTab() {
    await chrome.tabs.create({ url: chrome.runtime.getURL('camsetup.html') });
  }

  async queryCameraPermissionState(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
    if (!('permissions' in navigator)) return 'unknown';

    try {
      const status = await navigator.permissions.query({ name: 'camera' as PermissionName });
      return (status?.state as any) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async tryPrimeInline(): Promise<boolean> {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      s.getTracks().forEach((t) => t.stop());
      return true;
    } catch {
      return false;
    }
  }

  async ensureReadyForRecording(): Promise<boolean> {
    const state = await this.queryCameraPermissionState();
    if (state === 'granted') return true;

    const ok = await this.tryPrimeInline().catch(() => false);
    if (ok) return true;

    await this.openCameraSetupTab();
    return false;
  }
}
