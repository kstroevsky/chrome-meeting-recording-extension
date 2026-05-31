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

import { getCapturedTabs, getMediaStreamIdForTab, getTab } from '../platform/chrome/tabs';
import { loadRecorderRuntimeSettingsSnapshot } from '../shared/settings';
import type { RecorderRuntimeSettingsSnapshot } from '../shared/settings';
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
    this.session.start(runConfig, {
      targetTabId: msg.tabId,
      meetingSlug: meetingSlug || undefined,
    });
    this.L.log('Popup requested START_RECORDING for tabId', msg.tabId);

    try {
      await this.offscreen.ensureReady();
      this.L.log('ensureReady() completed');
    } catch (e: any) {
      const error = `Offscreen not ready: ${e?.message || e}`;
      this.session.fail(error);
      return this.fail(error);
    }

    try {
      const streamId = await getMediaStreamIdForTab(msg.tabId);
      const r = await this.offscreen.rpc<{ ok: boolean; error?: string }>({
        type: 'OFFSCREEN_START',
        streamId,
        meetingSlug,
        runConfig,
        recorderSettings,
      });

      this.L.log('rpc(OFFSCREEN_START) response', r);
      if (r?.ok) return this.ok();
      this.session.fail(r?.error || 'Failed to start');
      return this.fail(r?.error || 'Failed to start');
    } catch (e: any) {
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
      return captures.find(
        (c) => c.tabId === tabId && c.status !== 'stopped' && c.status !== 'error'
      ) ?? null;
    } catch (error) {
      this.L.warn('tabCapture.getCapturedTabs preflight failed; continuing without conflict check', error);
      return null;
    }
  }

  /** Extracts the last path segment from the active tab URL as the meeting slug. */
  private async resolveMeetingSlug(tabId: number): Promise<string> {
    try {
      const tab = await getTab(tabId);
      if (!tab?.url) return '';
      return new URL(tab.url).pathname.split('/').pop() || '';
    } catch { return ''; }
  }
}
