/**
 * @file popup/CaptionPoller.ts
 *
 * Polls the active tab's content script for live-caption presence and reflects it
 * on the recording view's transcript chip. Best-effort: if the tab is unreachable
 * (no content script, navigated away) the chip simply shows "off". Extracted from
 * PopupController so the controller stays a thin orchestrator and the poll loop can
 * be unit-tested in isolation.
 */

import { queryActiveTab } from '../platform/chrome/tabs';
import { sendToContent } from '../shared/messages';

/** How often the recording view polls the content script for live caption presence. */
const CAPTION_POLL_MS = 3000;

export class CaptionPoller {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly labelEl: HTMLElement | null,
    private readonly chipEl: HTMLElement | null,
  ) {}

  /** Starts polling: once immediately, then every CAPTION_POLL_MS. Idempotent. */
  start(): void {
    if (this.interval != null) return;
    void this.poll();
    this.interval = setInterval(() => void this.poll(), CAPTION_POLL_MS);
  }

  /** Stops polling (idempotent). */
  stop(): void {
    if (this.interval != null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Best-effort: asks the active tab whether Meet captions are live; off if unreachable. */
  private async poll(): Promise<void> {
    let active = false;
    try {
      const tab = await queryActiveTab();
      if (tab?.id) {
        const res = await sendToContent(tab.id, { type: 'GET_CAPTION_STATE' }).catch(() => undefined);
        active = res?.captionsActive === true;
      }
    } catch {
      active = false;
    }
    if (this.labelEl) this.labelEl.textContent = active ? 'Transcript on' : 'Transcript off';
    if (this.chipEl) this.chipEl.classList.toggle('off', !active);
  }
}
