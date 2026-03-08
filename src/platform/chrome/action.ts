/**
 * @file platform/chrome/action.ts
 *
 * Small adapter over the Chrome action badge API.
 */

export async function setActionBadgeText(text: string): Promise<void> {
  try {
    const result = chrome.action.setBadgeText({ text }) as Promise<void> | void;
    await result;
  } catch {}
}
