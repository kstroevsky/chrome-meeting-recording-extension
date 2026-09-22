/**
 * @context  Background Service Worker (MV3)
 * @role     Thin composition entrypoint for the background control plane.
 * @lifetime Event-driven. Chrome may suspend and restart this worker at will.
 *
 * Listener registration stays synchronous in this module. Durable state,
 * bootstrap/recovery, and cross-feature wiring live under background/runtime.
 */

import { createBackgroundRuntime } from './background/runtime/createBackgroundRuntime';
import { registerRecordingAutoStop } from './background/recording/recordingAutoStop';
import { registerRecordingCommands } from './background/recording/recordingCommands';
import { addTabRemovedListener } from './platform/chrome/tabs';

const runtime = createBackgroundRuntime();

/**
 * Exported for integration tests so they can await durable-state hydration
 * instead of guessing how many event-loop turns startup requires.
 */
export const sessionHydration = runtime.bootstrap();
void sessionHydration.catch(() => {});

// Runtime ingress is registered eagerly during module evaluation (MV3).
chrome.runtime.onMessage.addListener(runtime.messageListener);
chrome.runtime.onConnect.addListener(runtime.handleConnect);
chrome.runtime.onSuspend?.addListener(async () => {
  await runtime.handleSuspend();
});
chrome.alarms?.onAlarm?.addListener(runtime.handleAlarm);

registerRecordingCommands({
  L: runtime.logger,
  controller: runtime.controller,
  waitUntilReady: runtime.waitUntilReady,
});
registerRecordingAutoStop({
  session: runtime.session,
  controller: runtime.controller,
  waitUntilReady: runtime.waitUntilReady,
});

// Registered after recordingAutoStop so closing a recorded tab stops capture
// before playback/auth leases attached to that tab are released.
addTabRemovedListener(runtime.handleTabRemoved);

chrome.runtime.onUpdateAvailable?.addListener(() => {
  void sessionHydration
    .then(() => runtime.applyUpdateWhenSafe())
    .catch((error) => runtime.logger.warn('Update deferred because background is not ready:', error));
});

chrome.runtime.onInstalled?.addListener(async (details) => {
  if (details.reason !== 'update') return;
  try {
    await sessionHydration;
    await runtime.handleUpdatedExtension();
  } catch (error) {
    runtime.logger.warn('Extension update reconciliation deferred:', error);
  }
});

globalThis.addEventListener?.('error', runtime.handleGlobalError);
globalThis.addEventListener?.('unhandledrejection', runtime.handleUnhandledRejection);
