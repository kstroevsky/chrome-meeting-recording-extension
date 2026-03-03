export class MicPermissionService {
  async openMicSetupTab() {
    await chrome.tabs.create({ url: chrome.runtime.getURL('micsetup.html') });
  }

  async queryMicPermissionState(): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
    if (!('permissions' in navigator)) return 'unknown';

    try {
      const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      return (status?.state as any) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async tryPrimeInline(): Promise<boolean> {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      return true;
    } catch {
      return false;
    }
  }

  async ensurePrimedBestEffort(): Promise<void> {
    const state = await this.queryMicPermissionState();
    if (state === 'granted') return;

    // Try inline; if blocked, ignore and continue without mic (matches prior behavior)
    await this.tryPrimeInline().catch(() => {});
  }

  bindButton(
    micBtn: HTMLButtonElement,
    onTextChange?: (text: string) => void
  ) {
    const refresh = async () => {
      const state = await this.queryMicPermissionState();

      const text =
        state === 'granted'
          ? 'Microphone Enabled ✓'
          : state === 'denied'
          ? 'Microphone Blocked'
          : 'Enable Microphone';

      micBtn.textContent = text;
      onTextChange?.(text);

      micBtn.disabled = state === 'granted';
      micBtn.title =
        state === 'granted'
          ? 'Microphone is already enabled for this extension'
          : 'Grant microphone permission so your voice is included in recordings';
    };

    void refresh();

    micBtn.addEventListener('click', async () => {
      try {
        const state = await this.queryMicPermissionState();

        if (state === 'granted') {
          alert('Microphone is already enabled for this extension.');
          await refresh();
          return;
        }

        if (state === 'denied') {
          await this.openMicSetupTab();
          return;
        }

        const ok = await this.tryPrimeInline();
        if (ok) {
          alert('Microphone enabled for the extension.');
          await refresh();
          return;
        }

        await this.openMicSetupTab();
      } catch (e) {
        console.error('[popup] mic enable flow error', e);
        alert('Could not open the microphone setup page. Please try again.');
      }
    });

    return { refresh };
  }
}
