/**
 * @file background/offscreen/offscreenSender.ts
 *
 * Who may speak as the offscreen runtime. The `offscreen` Port carries every
 * recording command, so a peer that is not the runtime the background created
 * must never replace it.
 *
 * Two shapes are genuine, both measured in Chrome:
 * - the offscreen document: `offscreen.html`, no tab, no frame id;
 * - the recorder tab (`offscreen.html?runtime=tab`): top frame of a tab the
 *   background opened, so when that tab id is known it must match.
 *
 * Anything else — above all `offscreen.html` framed inside some web page —
 * is refused. The manifest keeps `offscreen.html` out of
 * `web_accessible_resources`, so a web page cannot load it at all; this check
 * is the second wall, in case that ever regresses.
 */

export function isTrustedOffscreenSender(
  sender: chrome.runtime.MessageSender | undefined,
  offscreenUrl: string,
  recorderTabId: number | null,
): boolean {
  // Compared as text: outside Chrome, `new URL()` gives chrome-extension: an
  // opaque "null" origin, so origin + pathname would not round-trip.
  if (!sender?.url || sender.url.split(/[?#]/, 1)[0] !== offscreenUrl) return false;

  if (!sender.tab) return sender.frameId == null || sender.frameId === 0;
  if (sender.frameId !== 0) return false;
  return recorderTabId == null || sender.tab.id === recorderTabId;
}
