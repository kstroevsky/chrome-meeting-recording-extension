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
import { type CommandResult, type NotationResult } from '../shared/protocol';
import { isStoppablePhase, parseRunConfig, toStatusView, type RecordingInputDevice, type RecordingInterruption } from '../shared/recording';
import type { OffscreenManager } from './OffscreenManager';
import type { RecordingSession } from './RecordingSession';
import type { RecordingNotationService } from './RecordingNotationService';
import type { RecordingTranscriptService } from './RecordingTranscriptService';
import type { RecordingTranscriptCapture } from './RecordingTranscriptCapture';
import type { TelemetryRuntime } from './TelemetryRuntime';
import { createTelemetryId } from '../shared/telemetry';
import { hasExportableNotations, toWebVtt } from '../shared/notationExport';

export type RecordingControllerDeps = {
  L: { log: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
  offscreen: OffscreenManager;
  session: RecordingSession;
  telemetry?: TelemetryRuntime;
  notations?: RecordingNotationService;
  transcripts?: RecordingTranscriptService;
  transcriptCapture?: RecordingTranscriptCapture;
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
  private readonly telemetry?: TelemetryRuntime;
  private readonly notations?: RecordingNotationService;
  private readonly transcripts?: RecordingTranscriptService;
  private readonly transcriptCapture?: RecordingTranscriptCapture;

  constructor({ L, offscreen, session, telemetry, notations, transcripts, transcriptCapture }: RecordingControllerDeps) {
    this.L = L;
    this.offscreen = offscreen;
    this.session = session;
    this.telemetry = telemetry;
    this.notations = notations;
    this.transcripts = transcripts;
    this.transcriptCapture = transcriptCapture;
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

    const telemetryRunId = this.telemetry?.start(runConfig) ?? createTelemetryId();

    let recorderSettings: RecorderRuntimeSettingsSnapshot;
    try {
      recorderSettings = await loadRecorderRuntimeSettingsSnapshot();
    } catch (e: any) {
      const error = `Failed to load recorder settings: ${e?.message || e}`;
      this.L.error(error);
      this.telemetry?.incident({ kind: 'recording_start_failed', stage: 'settings_load', error: e });
      return this.fail(error);
    }

    // The popup's per-recording tab content preset wins over the persisted default
    // baked into the snapshot. The snapshot is a fresh clone, so mutating is safe.
    if (runConfig.tabContentType && recorderSettings.tab?.output) {
      recorderSettings.tab.output.contentType = runConfig.tabContentType;
    }

    const meetingSlug = await this.resolveMeetingSlug(msg.tabId);
    const target = {
      targetTabId: msg.tabId,
      meetingSlug: meetingSlug || undefined,
    };
    const started = this.session.start(runConfig, target);
    this.telemetry?.configureRun(telemetryRunId, runConfig, recorderSettings, started.epoch);
    this.telemetry?.context('capture_requested');
    void chrome.tabs.sendMessage(msg.tabId, { type: 'TELEMETRY_RUN', runId: telemetryRunId, enabled: this.telemetry?.isEnabled() ?? false }).catch(() => {});
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
      this.telemetry?.incident({ kind: 'recording_start_failed', stage: 'runtime_ready', error: e });
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
        historyId: started.historyId ?? '',
        telemetryRunId,
        // Fencing token (ADR-0003): the offscreen echoes this in OFFSCREEN_STATE.
        epoch: started.epoch ?? 0,
      } as const;
      const r = await this.offscreen.rpc<{ ok: boolean; error?: string }>(startRequest);
      await this.restoreTargetTab(msg.tabId, recorderRuntimeTabId);

      this.L.log('rpc(OFFSCREEN_START) response', r);
      if (r?.ok) return this.ok();

      const error = r?.error || 'Failed to start';
      this.telemetry?.incident({ kind: 'recording_start_failed', stage: 'offscreen_start', error: new Error(error) });
      this.session.fail(error);
      return this.fail(error);
    } catch (e: any) {
      await this.restoreTargetTab(msg.tabId, recorderRuntimeTabId);
      this.L.error('OFFSCREEN_START failed', e);
      const error = `OFFSCREEN_START failed: ${e?.message || e}`;
      this.telemetry?.incident({ kind: 'recording_start_failed', stage: 'offscreen_rpc', error: e });
      this.session.fail(error);
      return this.fail(error);
    }
  }

  /**
   * Guards against stopping when no recording is active, marks the session as
   * stopping, and fires the OFFSCREEN_STOP RPC. Shared by the popup stop button,
   * the auto-stop tab listeners, and the meeting-ended signal.
   */
  async stop(reason = 'user requested stop', interruption?: RecordingInterruption['reason']): Promise<CommandResult> {
    if (!isStoppablePhase(this.session.getSnapshot().phase)) {
      return this.fail('Stop requested but no recording session is active');
    }
    const targetTabId = this.session.getSnapshot().targetTabId;
    if (typeof targetTabId === 'number') {
      try {
        const response = await chrome.tabs.sendMessage(targetTabId, { type: 'TELEMETRY_GET_SNAPSHOT' }) as { snapshot?: import('../shared/telemetry').TelemetrySnapshot };
        if (response?.snapshot) await this.telemetry?.receive(response.snapshot, true);
      } catch {}
    }
    const { historyId } = this.session.getSnapshot();
    // markStopping seals any note the run left open, so the export below is
    // complete by the time it rides the stop RPC (ADR-0005).
    this.session.markStopping(interruption);
    this.L.log('Stopping recording:', reason);
    // markStopping has closed the run's last recorded span, so this is the
    // cutoff. Drain the caption buffer against it *now*: Meet keeps refining a
    // caption after the recorder stops, and a refinement that arrives later
    // represents speech the file does not contain (ADR-0007). Awaited for the
    // same reason the notes sidecar is — it has to reflect the run, not a
    // moment somewhere after it.
    if (historyId) {
      await this.transcriptCapture?.flushAtBoundary(historyId)
        .catch((error) => this.L.warn('Could not flush captions at the stop boundary:', error));
    }
    const notesSidecar = await this.buildNotesSidecar(historyId);

    try {
      await this.offscreen.ensureReady();
      const r = await this.offscreen.rpc<{ ok: boolean; error?: string }>({
        type: 'OFFSCREEN_STOP',
        ...(notesSidecar ? { notesSidecar } : {}),
      });
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
   * Stops the active capture without entering either the local-save or Drive-upload
   * pipeline. The offscreen runtime seals only as needed to close its writers, then
   * deletes every resulting temporary artifact before reporting idle.
   */
  async discard(reason = 'user requested discard'): Promise<CommandResult> {
    if (!isStoppablePhase(this.session.getSnapshot().phase)) {
      return this.fail('Discard requested but no recording session is active');
    }
    const { historyId } = this.session.getSnapshot();
    this.session.markStopping();
    this.L.log('Discarding recording:', reason);

    // A discarded run leaves no recording behind, so its marks must not outlive
    // it as rows keyed to a history entry that will never be created.
    if (historyId) {
      await this.notations?.removeAll(historyId)
        .catch((error) => this.L.warn('Discarding recording notations failed:', error));
      await this.transcripts?.removeAll(historyId)
        .catch((error) => this.L.warn('Discarding recording transcript failed:', error));
    }

    try {
      await this.offscreen.ensureReady();
      const r = await this.offscreen.rpc<{ ok: boolean; error?: string }>({ type: 'OFFSCREEN_DISCARD' });
      if (!r?.ok) {
        this.session.fail(r?.error || 'Discard failed in offscreen');
        return this.fail(r?.error || 'Discard failed in offscreen');
      }
      return this.ok();
    } catch (e: any) {
      const error = `DISCARD failed: ${e?.message || e}`;
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
  /**
   * Retries a failed/partial background upload job (ADR-0004). Independent of the
   * recording phase — uploads run detached — so there is no capture guard; the
   * offscreen re-uploads the retained artifacts and reports the job back to
   * `uploading` via OFFSCREEN_UPLOAD_STATE before this resolves.
   */
  async retryUpload(jobId: string): Promise<CommandResult> {
    try {
      await this.offscreen.ensureReady();
      const r = await this.offscreen.rpc<{ ok: boolean; error?: string }>({ type: 'OFFSCREEN_RETRY_UPLOAD', jobId });
      if (!r?.ok) return this.fail(r?.error || 'Retry failed in offscreen');
      return this.ok();
    } catch (e: any) {
      return this.fail(`RETRY_UPLOAD failed: ${e?.message || e}`);
    }
  }

  /** Cancels a detached Drive upload; unfinished artifacts are downloaded locally. */
  async cancelUpload(jobId: string): Promise<CommandResult> {
    try {
      await this.offscreen.ensureReady();
      const r = await this.offscreen.rpc<{ ok: boolean; error?: string }>({ type: 'OFFSCREEN_CANCEL_UPLOAD', jobId });
      if (!r?.ok) return this.fail(r?.error || 'Cancel failed in offscreen');
      return this.ok();
    } catch (e: any) {
      return this.fail(`CANCEL_UPLOAD failed: ${e?.message || e}`);
    }
  }

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

  /** Switches a live microphone/camera source while preserving the recorder timeline. */
  async setInputDevice(device: RecordingInputDevice, deviceId: string): Promise<CommandResult> {
    const snapshot = this.session.getSnapshot();
    if (snapshot.phase !== 'recording') {
      return this.fail('Input device can only be changed while recording');
    }
    if (device === 'microphone') {
      const micMode = snapshot.runConfig?.micMode;
      if (micMode !== 'mixed' && micMode !== 'separate') {
        return this.fail('This recording has no microphone');
      }
    } else if (device === 'camera') {
      if (snapshot.runConfig?.recordSelfVideo !== true) return this.fail('This recording has no camera');
    } else {
      return this.fail('Invalid input device type');
    }
    if (typeof deviceId !== 'string' || !deviceId) return this.fail('Missing input device');

    try {
      await this.offscreen.ensureReady();
      const result = await this.offscreen.rpc<{ ok: boolean; label?: string; error?: string }>({
        type: 'OFFSCREEN_SET_INPUT_DEVICE',
        device,
        deviceId,
      });
      if (!result?.ok || !result.label) return this.fail(result?.error || 'Input device change failed in offscreen');
      this.session.setCapturedDevice(device, result.label);
      return this.ok();
    } catch (error: any) {
      return this.fail(`SET_INPUT_DEVICE failed: ${error?.message || error}`);
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
      // Close the caption buffer on the pause boundary, so a sentence spoken
      // across it arrives as two utterances that each land in real media rather
      // than one that spans a gap the file does not contain (ADR-0007).
      if (paused && snapshot.historyId) {
        void this.transcriptCapture?.flushAtBoundary(snapshot.historyId)
          .catch((error) => this.L.warn('Could not flush captions at the pause boundary:', error));
      }
      return this.ok();
    } catch (e: any) {
      return this.fail(`SET_PAUSED failed: ${e?.message || e}`);
    }
  }

  /**
   * Renders the run's notes to WebVTT for the offscreen to deliver ahead of the
   * media. The background does the rendering because it owns the notations; the
   * offscreen owns delivery and names the file. Best-effort — a recording must
   * still stop and save when its notes cannot be read.
   */
  private async buildNotesSidecar(historyId: string | undefined): Promise<{ vtt: string } | undefined> {
    if (!historyId || !this.notations) return undefined;
    try {
      const notations = await this.notations.list(historyId);
      if (!hasExportableNotations(notations)) return undefined;
      return { vtt: toWebVtt(notations, { durationMs: this.session.runDurationMs(historyId) }) };
    } catch (error) {
      this.L.warn('Could not export notes for this recording:', error);
      return undefined;
    }
  }

  /**
   * Stamps a notation at the live recording position (ADR-0005).
   *
   * Guarded on `recording` specifically, not the broader `isStoppablePhase` the
   * other live commands use: during `starting` the clock still reads 0 and the
   * offscreen has not confirmed capture, and during `stopping` it is already
   * banked while the media seals — a mark taken in either window would point at
   * an offset the file does not have.
   */
  async markNotation(text?: string): Promise<NotationResult> {
    const snapshot = this.session.getSnapshot();
    if (snapshot.phase !== 'recording') {
      return { ok: false, error: 'Mark requested but no recording is active' };
    }
    if (!snapshot.historyId) {
      return { ok: false, error: 'The active recording has no history identity' };
    }
    if (!this.notations) return { ok: false, error: 'Recording notations are unavailable' };

    try {
      const notation = await this.notations.add(snapshot.historyId, {
        tStartMs: this.session.currentRecordedMs(),
        text,
      });
      this.L.log('Marked notation', notation.id, 'at', notation.tStartMs, 'ms');
      return { ok: true, notation };
    } catch (e: any) {
      const error = `MARK_NOTATION failed: ${e?.message || e}`;
      this.L.warn(error);
      return { ok: false, error };
    }
  }

  /**
   * One gesture starts a note and the same gesture ends it (⌥M), so a note owns
   * a span rather than an instant. The decision is made here because the
   * keyboard path has no popup state to consult.
   */
  async toggleNotation(): Promise<NotationResult> {
    const { historyId, phase } = this.session.getSnapshot();
    if (phase !== 'recording' || !historyId) {
      return { ok: false, error: 'Mark requested but no recording is active' };
    }
    if (!this.notations) return { ok: false, error: 'Recording notations are unavailable' };

    try {
      const open = (await this.notations.list(historyId)).find((notation) => notation.tEndMs == null);
      return open ? await this.endNotation(open.id) : await this.markNotation();
    } catch (e: any) {
      const error = `TOGGLE_NOTATION failed: ${e?.message || e}`;
      this.L.warn(error);
      return { ok: false, error };
    }
  }

  /** Closes an open notation at the live recording position. */
  async endNotation(id: string): Promise<NotationResult> {
    const snapshot = this.session.getSnapshot();
    if (snapshot.phase !== 'recording') {
      return { ok: false, error: 'Mark end requested but no recording is active' };
    }
    if (!snapshot.historyId) {
      return { ok: false, error: 'The active recording has no history identity' };
    }
    if (!this.notations) return { ok: false, error: 'Recording notations are unavailable' };

    try {
      const notation = await this.notations.endOpen(snapshot.historyId, id, this.session.currentRecordedMs());
      return { ok: true, notation };
    } catch (e: any) {
      const error = `END_NOTATION failed: ${e?.message || e}`;
      this.L.warn(error);
      return { ok: false, error };
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
