/**
 * @file background/commands/handleStartRecording.ts
 *
 * Handles the START_RECORDING popup command: validates inputs, resolves a
 * stream ID and meeting slug, loads recorder settings, and delegates to the
 * offscreen document via RPC.
 */

import { getCapturedTabs, getMediaStreamIdForTab } from '../../platform/chrome/tabs';
import {
  buildRecorderRuntimeSettingsSnapshot,
  loadExtensionSettingsFromStorage,
} from '../../shared/extensionSettings';
import { type CommandResult } from '../../shared/protocol';
import { parseRunConfig } from '../../shared/recording';
import type { MessageHandlersDeps } from '../messageHandlers';

type StartRecordingMsg = {
  type: 'START_RECORDING';
  tabId: unknown;
  runConfig: unknown;
};

const ok = (session: MessageHandlersDeps['session']): CommandResult =>
  ({ ok: true, session: session.getSnapshot() });
const fail = (error: string, session: MessageHandlersDeps['session']): CommandResult =>
  ({ ok: false, error, session: session.getSnapshot() });

/** Checks for an existing tab capture that would conflict with a new recording start. */
async function findTabCaptureConflict(
  tabId: number,
  L: MessageHandlersDeps['L']
): Promise<chrome.tabCapture.CaptureInfo | null> {
  try {
    const captures = await getCapturedTabs();
    return captures.find(
      (c) => c.tabId === tabId && c.status !== 'stopped' && c.status !== 'error'
    ) ?? null;
  } catch (error) {
    L.warn('tabCapture.getCapturedTabs preflight failed; continuing without conflict check', error);
    return null;
  }
}

/** Extracts the last path segment from the active tab URL as the meeting slug. */
async function resolveMeetingSlug(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url) return '';
    return new URL(tab.url).pathname.split('/').pop() || '';
  } catch { return ''; }
}

/**
 * Validates the START_RECORDING message, acquires streams and recorder
 * settings, then fires the OFFSCREEN_START RPC.
 */
export async function handleStartRecording(
  msg: StartRecordingMsg,
  { L, offscreen, session }: MessageHandlersDeps,
  sendResponse: (response: CommandResult) => void
): Promise<void> {
  if (typeof msg.tabId !== 'number') {
    sendResponse(fail('Missing tabId', session));
    return;
  }
  const runConfig = parseRunConfig(msg.runConfig);
  if (!runConfig) {
    sendResponse(fail('Missing or invalid run configuration', session));
    return;
  }

  const conflict = await findTabCaptureConflict(msg.tabId, L);
  if (conflict) {
    sendResponse(fail(
      `This tab already has an active tab capture (${conflict.status}). Stop the existing capture and try again.`,
      session
    ));
    return;
  }

  let recorderSettings: ReturnType<typeof buildRecorderRuntimeSettingsSnapshot>;
  try {
    recorderSettings = buildRecorderRuntimeSettingsSnapshot(await loadExtensionSettingsFromStorage());
  } catch (e: any) {
    const error = `Failed to load recorder settings: ${e?.message || e}`;
    L.error(error);
    sendResponse(fail(error, session));
    return;
  }

  session.start(runConfig);
  L.log('Popup requested START_RECORDING for tabId', msg.tabId);

  try {
    await offscreen.ensureReady();
    L.log('ensureReady() completed');
  } catch (e: any) {
    session.fail(`Offscreen not ready: ${e?.message || e}`);
    sendResponse(fail(`Offscreen not ready: ${e?.message || e}`, session));
    return;
  }

  try {
    const [streamId, meetingSlug] = await Promise.all([
      getMediaStreamIdForTab(msg.tabId),
      resolveMeetingSlug(msg.tabId),
    ]);
    const r = await offscreen.rpc<{ ok: boolean; error?: string }>({
      type: 'OFFSCREEN_START',
      streamId,
      meetingSlug,
      runConfig,
      recorderSettings,
    });

    L.log('rpc(OFFSCREEN_START) response', r);
    if (r?.ok) {
      sendResponse(ok(session));
    } else {
      session.fail(r?.error || 'Failed to start');
      sendResponse(fail(r?.error || 'Failed to start', session));
    }
  } catch (e: any) {
    L.error('OFFSCREEN_START failed', e);
    session.fail(`OFFSCREEN_START failed: ${e?.message || e}`);
    sendResponse(fail(`OFFSCREEN_START failed: ${e?.message || e}`, session));
  }
}
