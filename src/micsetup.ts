// src/micsetup.ts

/**
 * MICROPHONE SETUP PAGE
 * 
 * In Chrome extensions, granting microphone permission to a popup or an offscreen
 * document can be inconsistent or restricted. 
 * 
 * This full-page tab is used to "prime" the permission. Once the user clicks
 * 'Enable' and accepts the Chrome prompt, the permission is granted to the 
 * EXTENSION ORIGIN (chrome-extension://...) permanently.
 * 
 * This allows the Offscreen document to later call getUserMedia() without a prompt.
 */

/**
 * @context  Microphone Setup Page (full browser tab)
 * @role     Permission Primer — exists solely to acquire the microphone permission
 *           on behalf of the extension origin (chrome-extension://...).
 * @lifetime Lives as a regular browser tab; user can close it when done.
 *
 * Why a separate tab?
 *   In MV3, popups and offscreen documents cannot reliably trigger permission
 *   prompts for getUserMedia(). Opening a full tab with this page is the only
 *   consistent way to show the Chrome media permission dialog for an extension.
 *   Once the user accepts, the permission is granted to the extension origin
 *   permanently, so the Offscreen document can later call getUserMedia({audio})
 *   without another prompt.
 *
 *   This tab is opened by MicPermissionService.openMicSetupTab() when the
 *   extension detects the microphone permission is 'denied' or cannot be granted
 *   inline from the popup.
 *
 * @see src/popup/MicPermissionService.ts  — decides when to open this page
 */

document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('enable') as HTMLButtonElement | null;
    const statusEl = document.getElementById('status') as HTMLParagraphElement | null;
  
    if (!btn || !statusEl) return;
  
    btn.addEventListener('click', async () => {
      statusEl.textContent = 'Requesting microphone…';
      try {
        // Step 1: Trigger the standard browser permission prompt
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Step 2: Immediately stop the tracks. We only needed the PERMISSION, 
        // not the actual stream here.
        s.getTracks().forEach(t => t.stop());
        
        statusEl.textContent = 'Microphone enabled. You can close this tab.';
      } catch (e: any) {
        statusEl.textContent = `Mic blocked: ${e?.name || e}. Check Chrome & OS settings.`;
        console.error('[micsetup] getUserMedia error:', e);
      }
    });
  });
  