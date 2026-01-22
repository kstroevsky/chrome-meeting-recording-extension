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
  