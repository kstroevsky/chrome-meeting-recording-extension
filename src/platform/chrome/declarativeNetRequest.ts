/**
 * @file platform/chrome/declarativeNetRequest.ts
 *
 * Promise-based wrappers around the declarativeNetRequest session-rule API.
 *
 * Session rules — not dynamic ones — because tab-scoped matching (`tabIds`) is
 * only available on session rules, and because a playback authorization should
 * die with the browser session rather than persist to disk.
 *
 * Per ADR-0001 every Chrome *operation* goes through this layer; features do
 * not reach past it to `chrome.*`.
 */

export type SessionRule = chrome.declarativeNetRequest.Rule;

function available(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.declarativeNetRequest?.updateSessionRules === 'function';
}

export async function getSessionRules(): Promise<SessionRule[]> {
  if (!available()) return [];
  return await chrome.declarativeNetRequest.getSessionRules();
}

export async function updateSessionRules(update: {
  addRules?: SessionRule[];
  removeRuleIds?: number[];
}): Promise<void> {
  if (!available()) throw new Error('declarativeNetRequest session rules are unavailable');
  await chrome.declarativeNetRequest.updateSessionRules(update);
}
