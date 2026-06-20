/**
 * @file background/recordingAutoStop.ts
 *
 * Conservative automatic stop triggers for the tab and meeting lifecycle.
 */

import { addTabRemovedListener, addTabUpdatedListener } from '../platform/chrome/tabs';
import type { ContentMeetingEnded } from '../shared/protocol';
import type { RecordingSessionSnapshot } from '../shared/recording';
import type { RecordingSession } from './RecordingSession';
import { isStoppablePhase } from '../shared/recording';
import type { RecordingController } from './RecordingController';

type AutoStopDeps = {
  session: RecordingSession;
  controller: RecordingController;
};

function getMeetSlug(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'meet.google.com') return null;
    const code = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    return code ? `meet-${code}` : null;
  } catch {
    return null;
  }
}

function isSameRecordingTab(snapshot: RecordingSessionSnapshot, tabId: number | undefined): boolean {
  return typeof tabId === 'number'
    && snapshot.targetTabId === tabId
    && isStoppablePhase(snapshot.phase);
}

function isSameMeeting(snapshot: RecordingSessionSnapshot, meetingId: string | null | undefined): boolean {
  if (!snapshot.meetingSlug || !meetingId) return false;
  const slug = snapshot.meetingSlug;
  // The session stores Meet slugs as 'meet-{room-code}'; the content script sends the raw room code.
  return meetingId === slug || `meet-${meetingId}` === slug;
}

/**
 * Whether this recording targets a Google Meet call. Meet recordings store a
 * 'meet-{room-code}' slug; everything else stores a sanitized tab-title slug (or
 * none). The navigation auto-stop is Meet-only — "left the meeting room" has no
 * meaning for an arbitrary tab, where in-tab navigation (including SPA URL
 * changes on sites like YouTube or Docs) is normal browsing, not a stop signal.
 */
function isMeetRecording(snapshot: RecordingSessionSnapshot): boolean {
  return !!snapshot.meetingSlug && snapshot.meetingSlug.startsWith('meet-');
}

async function stopIfTargetMatches(
  deps: AutoStopDeps,
  tabId: number | undefined,
  meetingId: string | null | undefined,
  reason: string
): Promise<{ ok: true; stopped: boolean; reason: string } | { ok: false; stopped: false; error: string }> {
  const snapshot = deps.session.getSnapshot();
  if (!isSameRecordingTab(snapshot, tabId)) {
    return { ok: true, stopped: false, reason: 'not-recording-target' };
  }
  if (!isSameMeeting(snapshot, meetingId)) {
    return { ok: true, stopped: false, reason: 'meeting-mismatch' };
  }

  const result = await deps.controller.stop(reason);
  if (result.ok) return { ok: true, stopped: true, reason };
  return { ok: false, stopped: false, error: result.error };
}

/** Handles the content-script signal that the recorded Meet call appears ended. */
export async function handleMeetingEndedMessage(
  msg: ContentMeetingEnded,
  sender: chrome.runtime.MessageSender,
  deps: AutoStopDeps
): Promise<{ ok: true; stopped: boolean; reason: string } | { ok: false; stopped: false; error: string }> {
  const meetingId = typeof msg.meetingId === 'string' && msg.meetingId.trim()
    ? msg.meetingId.trim()
    : null;
  const tabId = sender.tab?.id;
  const reason = typeof msg.reason === 'string' && msg.reason.trim()
    ? `meeting ended: ${msg.reason.trim()}`
    : 'meeting ended';
  return stopIfTargetMatches(deps, tabId, meetingId, reason);
}

/** Registers Chrome tab lifecycle hard-stops for the recorded tab. */
export function registerRecordingAutoStop(deps: AutoStopDeps): void {
  addTabRemovedListener((tabId) => {
    const snapshot = deps.session.getSnapshot();
    if (!isSameRecordingTab(snapshot, tabId)) return;
    void deps.controller.stop('recorded tab closed');
  });

  addTabUpdatedListener((tabId, changeInfo) => {
    if (typeof changeInfo.url !== 'string') return;
    const snapshot = deps.session.getSnapshot();
    if (!isSameRecordingTab(snapshot, tabId)) return;
    // Only Meet recordings auto-stop on navigation. A non-Meet recording keeps
    // running across in-tab URL changes and is hard-stopped only when the tab
    // closes (above) or the user stops it; otherwise an SPA route change would
    // silently kill the recording mid-session.
    if (!isMeetRecording(snapshot)) return;

    const nextSlug = getMeetSlug(changeInfo.url);
    if (nextSlug === snapshot.meetingSlug) return;
    void deps.controller.stop('recorded tab navigated away from meeting');
  });
}
