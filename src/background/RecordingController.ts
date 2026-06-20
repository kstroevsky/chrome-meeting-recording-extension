/**
 * @file background/RecordingController.ts
 *
 * Single orchestrator for the recording control plane. Owns the start and stop
 * decisions, the session-state transitions they imply, and the OFFSCREEN_START /
 * OFFSCREEN_STOP RPC handshake with the offscreen document.
 *
 * Every trigger drives recording through this one interface — the popup
 * START_RECORDING / STOP_RECORDING commands, the auto-stop tab listeners, and
 * the content-script meeting-ended signal — so failure shaping, session
 * transitions, and RPC sequencing all live in one place rather than spread
 * across separate command handlers.
 */

import {
  activateTab,
  getCapturedTabs,
  getMediaStreamIdForTab,
  getTab,
} from '../platform/chrome/tabs';
import { isE2ERealCaptureTabBuild } from '../shared/build';
import { loadRecorderRuntimeSettingsSnapshot } from '../shared/settings';
import type { RecorderRuntimeSettingsSnapshot } from '../shared/settings';
import { getPerfSettingsSnapshot } from '../shared/perf';
import { type CommandResult } from '../shared/protocol';
import { isStoppablePhase, parseRunConfig, toStatusView } from '../shared/recording';
import type { OffscreenManager } from './OffscreenManager';
import type { RecordingSession } from './RecordingSession';

export type RecordingControllerDeps = {
  L: { log: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
  offscreen: OffscreenManager;
  session: RecordingSession;
};

export type StartRecordingMessage = {
  type: 'START_RECORDING';
  tabId: unknown;
  runConfig: unknown;
};

function isBlockingCapture(
  capture: chrome.tabCapture.CaptureInfo,
  tabId: number
): boolean {
  return (
    capture.tabId === tabId
    && capture.status !== 'stopped'
    && capture.status !== 'error'
  );
}

export class RecordingController {
  private readonly L: RecordingControllerDeps['L'];
  private readonly offscreen: OffscreenManager;
  private readonly session: RecordingSession;

  constructor({ L, offscreen, session }: RecordingControllerDeps) {
    this.L = L;
    this.offscreen = offscreen;
    this.session = session;
  }

  /**
   * Validates the START_RECORDING request, resolves a stream ID, meeting slug,
   * and frozen recorder settings, transitions the session to `starting`, and
   * fires the OFFSCREEN_START RPC.
   */
  async start(msg: StartRecordingMessage): Promise<CommandResult> {
    if (typeof msg.tabId !== 'number') return this.fail('Missing tabId');

    const runConfig = parseRunConfig(msg.runConfig);
    if (!runConfig) return this.fail('Missing or invalid run configuration');

    const conflict = await this.findTabCaptureConflict(msg.tabId);
    if (conflict) {
      return this.fail(
        `This tab already has an active tab capture (${conflict.status}). Stop the existing capture and try again.`
      );
    }

    let recorderSettings: RecorderRuntimeSettingsSnapshot;
    try {
      recorderSettings = await loadRecorderRuntimeSettingsSnapshot();
    } catch (e: any) {
      const error = `Failed to load recorder settings: ${e?.message || e}`;
      this.L.error(error);
      return this.fail(error);
    }

    const meetingSlug = await this.resolveMeetingSlug(msg.tabId);
    const target = {
      targetTabId: msg.tabId,
      meetingSlug: meetingSlug || undefined,
    };
    const started = this.session.start(runConfig, target);
    this.L.log('Popup requested START_RECORDING for tabId', msg.tabId);

    const useLiveRecorderTab = isE2ERealCaptureTabBuild();
    let recorderRuntimeTabId: number | undefined;
    try {
      if (useLiveRecorderTab) {
        recorderRuntimeTabId = await this.offscreen.ensureRecorderTabReady();
        this.L.warn(
          'E2E real capture tab runtime selected before requesting the first stream ID'
        );
      } else {
        await this.offscreen.ensureReady();
        this.L.log('ensureReady() completed');
      }
    } catch (e: any) {
      const error = `Recording runtime not ready: ${e?.message || e}`;
      this.session.fail(error);
      return this.fail(error);
    }

    try {
      const streamId = await getMediaStreamIdForTab(msg.tabId);
      const startRequest = {
        type: 'OFFSCREEN_START',
        streamId,
        meetingSlug,
        runConfig,
        recorderSettings,
        perfSettings: getPerfSettingsSnapshot(),
        // Fencing token (ADR-0003): the offscreen echoes this in OFFSCREEN_STATE.
        epoch: started.epoch ?? 0,
      } as const;
      const r = await this.offscreen.rpc<{ ok: boolean; error?: string }>(startRequest);
      await this.restoreTargetTab(msg.tabId, recorderRuntimeTabId);

      this.L.log('rpc(OFFSCREEN_START) response', r);
      if (r?.ok) return this.ok();

      const error = r?.error || 'Failed to start';
      this.session.fail(error);
      return this.fail(error);
    } catch (e: any) {
      await this.restoreTargetTab(msg.tabId, recorderRuntimeTabId);
      this.L.error('OFFSCREEN_START failed', e);
      const error = `OFFSCREEN_START failed: ${e?.message || e}`;
      this.session.fail(error);
      return this.fail(error);
    }
  }

  /**
   * Guards against stopping when no recording is active, marks the session as
   * stopping, and fires the OFFSCREEN_STOP RPC. Shared by the popup stop button,
   * the auto-stop tab listeners, and the meeting-ended signal.
   */
  async stop(reason = 'user requested stop'): Promise<CommandResult> {
    if (!isStoppablePhase(this.session.getSnapshot().phase)) {
      return this.fail('Stop requested but no recording session is active');
    }
    this.session.markStopping();
    this.L.log('Stopping recording:', reason);

    try {
      await this.offscreen.ensureReady();
      const r = await this.offscreen.rpc<{ ok: boolean; error?: string }>({ type: 'OFFSCREEN_STOP' });
      if (!r?.ok) {
        this.session.fail(r?.error || 'Stop failed in offscreen');
        return this.fail(r?.error || 'Stop failed in offscreen');
      }
      return this.ok();
    } catch (e: any) {
      const error = `STOP failed: ${e?.message || e}`;
      this.session.fail(error);
      return this.fail(error);
    }
  }

  /**
   * Toggles mic mute on the live recording. Guards that capture is active and
   * that the run actually has a microphone, forwards the actuation to the
   * offscreen engine, and on success mirrors the flag onto the session so the
   * popup reflects it. Mute is silence-in-place: the mic stream keeps flowing,
   * so a failed toggle leaves the recording untouched (no session failure).
   */
  async setMicMuted(muted: boolean): Promise<CommandResult> {
    const snapshot = this.session.getSnapshot();
    if (!isStoppablePhase(snapshot.phase)) {
      return this.fail('Mic mute requested but no recording is active');
    }
    const micMode = snapshot.runConfig?.micMode;
    if (micMode !== 'mixed' && micMode !== 'separate') {
      return this.fail('Mic mute requested but this recording has no microphone');
    }

    try {
      await this.offscreen.ensureReady();
      const r = await this.offscreen.rpc<{ ok: boolean; error?: string }>({
        type: 'OFFSCREEN_SET_MIC_MUTED',
        muted,
      });
      if (!r?.ok) return this.fail(r?.error || 'Mic mute failed in offscreen');
      this.session.setMicMuted(muted);
      return this.ok();
    } catch (e: any) {
      return this.fail(`SET_MIC_MUTED failed: ${e?.message || e}`);
    }
  }

  /**
   * Hides/shows the camera on the live self-video recording. Same shape as
   * {@link setMicMuted}: guards that capture is active and the run records a
   * camera, relays to the offscreen engine, and mirrors the flag onto the
   * session. Black-frames-in-place — a failed toggle leaves recording untouched.
   */
  async setCameraMuted(muted: boolean): Promise<CommandResult> {
    const snapshot = this.session.getSnapshot();
    if (!isStoppablePhase(snapshot.phase)) {
      return this.fail('Camera hide requested but no recording is active');
    }
    if (snapshot.runConfig?.recordSelfVideo !== true) {
      return this.fail('Camera hide requested but this recording has no camera');
    }

    try {
      await this.offscreen.ensureReady();
      const r = await this.offscreen.rpc<{ ok: boolean; error?: string }>({
        type: 'OFFSCREEN_SET_CAMERA_MUTED',
        muted,
      });
      if (!r?.ok) return this.fail(r?.error || 'Camera hide failed in offscreen');
      this.session.setCameraMuted(muted);
      return this.ok();
    } catch (e: any) {
      return this.fail(`SET_CAMERA_MUTED failed: ${e?.message || e}`);
    }
  }

  /**
   * Pauses/resumes the whole live recording. Guards only that capture is active
   * (pause spans every stream, so there is no mic/camera sub-guard), relays to
   * the offscreen engine, and on success mirrors the flag onto the session. The
   * paused span is never written, so resume yields a seamless join; a failed
   * toggle leaves the recording untouched (this.fail does not mutate the session).
   */
  async setPaused(paused: boolean): Promise<CommandResult> {
    const snapshot = this.session.getSnapshot();
    if (!isStoppablePhase(snapshot.phase)) {
      return this.fail('Pause requested but no recording is active');
    }

    try {
      await this.offscreen.ensureReady();
      const r = await this.offscreen.rpc<{ ok: boolean; error?: string }>({
        type: 'OFFSCREEN_SET_PAUSED',
        paused,
      });
      if (!r?.ok) return this.fail(r?.error || 'Pause failed in offscreen');
      this.session.setPaused(paused);
      return this.ok();
    } catch (e: any) {
      return this.fail(`SET_PAUSED failed: ${e?.message || e}`);
    }
  }

  /** Builds a success CommandResult carrying the current popup-facing status view. */
  private ok(): CommandResult {
    return { ok: true, session: toStatusView(this.session.getSnapshot()) };
  }

  /** Builds a failure CommandResult carrying the current popup-facing status view. */
  private fail(error: string): CommandResult {
    return { ok: false, error, session: toStatusView(this.session.getSnapshot()) };
  }

  /** Checks for an existing tab capture that would conflict with a new recording start. */
  private async findTabCaptureConflict(tabId: number): Promise<chrome.tabCapture.CaptureInfo | null> {
    try {
      const captures = await getCapturedTabs();
      return captures.find((capture) => isBlockingCapture(capture, tabId)) ?? null;
    } catch (error) {
      this.L.warn('tabCapture.getCapturedTabs preflight failed; continuing without conflict check', error);
      return null;
    }
  }

  /** Restores Meet after the recorder extension tab has acquired its stream. */
  private async restoreTargetTab(tabId: number, recorderRuntimeTabId?: number): Promise<void> {
    if (recorderRuntimeTabId == null) return;
    try {
      await activateTab(tabId);
    } catch (error) {
      this.L.warn('Failed to restore the captured tab after stream acquisition', error);
    }
  }

  /**
   * Derives a filesystem-safe slug that labels the recording.
   * Google Meet: `meet-{room-code}` (e.g. `meet-abc-defg-hij`).
   * Everything else: up to 48 characters sanitized from the tab title,
   * falling back to `{hostname}{pathname}` when the title is absent.
   */
  private async resolveMeetingSlug(tabId: number): Promise<string> {
    try {
      const tab = await getTab(tabId);
      if (!tab?.url) return '';
      const url = new URL(tab.url);
      if (url.hostname === 'meet.google.com') {
        const code = url.pathname.split('/').filter(Boolean).pop() ?? '';
        return code ? `meet-${code}` : '';
      }
      // Prefer the tab title, but a title with no Latin alphanumerics (e.g. CJK or
      // Cyrillic) sanitizes to an empty slug — fall back to the ASCII host+path so
      // the recording still gets a meaningful name instead of just a bare timestamp.
      const titleSlug = tab.title ? RecordingController.sanitizeAsSlug(tab.title) : '';
      return titleSlug || RecordingController.sanitizeAsSlug(`${url.hostname}${url.pathname}`);
    } catch { return ''; }
  }

  /** Converts arbitrary text into a lowercase, dash-separated filename-safe slug. */
  private static sanitizeAsSlug(text: string, maxLength = 48): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength)
      .replace(/-+$/, '');
  }
}
