/**
 * @context  Camera Setup Page (full browser tab)
 * @role     Permission primer for camera capture on the extension origin.
 * @lifetime Lives as a regular browser tab until the user closes it.
 */

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('enable') as HTMLButtonElement | null;
  const statusEl = document.getElementById('status') as HTMLParagraphElement | null;

  if (!btn || !statusEl) return;

  btn.addEventListener('click', async () => {
    statusEl.textContent = 'Requesting camera…';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      s.getTracks().forEach((t) => t.stop());
      statusEl.textContent = 'Camera enabled. You can close this tab and retry recording.';
    } catch (e: any) {
      statusEl.textContent = `Camera blocked: ${e?.name || e}. Check Chrome & OS camera settings.`;
      console.error('[camsetup] getUserMedia error:', e);
    }
  });
});
