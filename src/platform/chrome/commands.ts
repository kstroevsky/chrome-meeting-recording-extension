/** Thin wrapper for command listener registration outside an entrypoint. */

export function addCommandListener(
  listener: Parameters<typeof chrome.commands.onCommand.addListener>[0],
): void {
  chrome.commands.onCommand.addListener(listener);
}
