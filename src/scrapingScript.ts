/**
 * @context  Content Script (injected into https://meet.google.com/*)
 * @role     Transcriber — watches the Google Meet DOM for live captions and
 *           buffers them into a coherent, time-stamped transcript.
 * @lifetime Injected once per page load (run_at: document_idle).
 *           State lives in this module's closures for the lifetime of the tab.
 *
 * Logic overview:
 *   1. A top-level MutationObserver waits for the Captions region to appear
 *      (it only exists when captions are enabled by the user in Meet).
 *   2. A second observer watches that region for new speaker blocks.
 *   3. A third observer (per block) watches for text refinements — Meet
 *      continuously updates caption text as the speech engine refines its guess.
 *   4. Per-speaker timers (CAPTION_GRACE_MS) fire after silence to commit
 *      the buffered utterance to the final transcript array.
 *
 * Public API exposed to the Popup:
 *   chrome.runtime.onMessage: GET_TRANSCRIPT, RESET_TRANSCRIPT
 *   window.getTranscript(), window.resetTranscript() (dev convenience only)
 *
 * Public API exposed to Background:
 *   chrome.runtime.onMessage: SET_TRANSCRIPT_CAPTURE, GET_TRANSCRIPT_UTTERANCES
 *   Pushes TRANSCRIPT_UTTERANCES while armed, so a transcript survives this tab
 *   closing mid-call (ADR-0007 Decision 1).
 *
 * @see src/shared/protocol.ts  — GET_TRANSCRIPT / RESET_TRANSCRIPT types
 * @see src/shared/timeouts.ts  — CAPTION_GRACE_MS constant
 */

import { GoogleMeetAdapter } from './content/GoogleMeetAdapter';
import type { MeetingProviderAdapter } from './content/MeetingProviderAdapter';
import { trySendRuntimeMessage } from './platform/chrome/runtime';
import { isPopupToContentMessage, type TranscriptCaptureState } from './shared/protocol';
import {
  configurePerfRuntime,
  logPerf,
  nowMs,
  roundMs,
  type PerfEventEntry,
} from './shared/perf';
import { CaptionBuffer } from './content/captionBuffer';
import type { CaptionUtterance } from './shared/transcript';
import { MeetingEndDetector, type MeetingEndedPayload } from './content/MeetingEndDetector';
import { TelemetryAccumulator, type TelemetrySink, type TelemetrySnapshot } from './shared/telemetry';
import { addStorageChangedListener } from './platform/chrome/storage';
import { normalizeExtensionSettings } from './shared/settings';

let captionTelemetry: TelemetryAccumulator | null = null;
let perfDebugEnabled = false;
let contentLongTaskObserver: PerformanceObserver | null = null;
const captionTelemetrySink: TelemetrySink = {
  increment: (...args) => captionTelemetry?.increment(...args),
  measure: (...args) => captionTelemetry?.measure(...args),
  context: (...args) => captionTelemetry?.context(...args),
  incident: (...args) => captionTelemetry?.incident(...args),
  checkpoint: (...args) => captionTelemetry?.checkpoint(...args),
  flush: (...args) => captionTelemetry?.flush(...args),
};

function sendPerfEvent(entry: PerfEventEntry) {
  void trySendRuntimeMessage({ type: 'PERF_EVENT', entry });
}

const perfRuntimeReady = configurePerfRuntime({
  source: 'captions',
  sink: sendPerfEvent,
  telemetrySink: captionTelemetrySink,
  onSettingsChanged: (settings) => {
    perfDebugEnabled = settings.debugMode;
    updateContentMainThreadLongTaskObserver();
  },
});

setInterval(() => captionTelemetry?.checkpoint(), 60_000);
chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if ((msg as any).type === 'TELEMETRY_RUN') {
    const runId = typeof (msg as any).runId === 'string' ? (msg as any).runId : null;
    captionTelemetry?.checkpoint(true);
    captionTelemetry = runId && (msg as any).enabled !== false
      ? new TelemetryAccumulator(runId, 'captions', {
          onCheckpoint: (snapshot, critical) => void trySendRuntimeMessage({ type: 'TELEMETRY_SNAPSHOT', snapshot, critical }),
        })
      : null;
    updateContentMainThreadLongTaskObserver();
    collector.reportActiveBlockObserverCount();
    sendResponse({ ok: true });
    return false;
  }
  if ((msg as any).type === 'TELEMETRY_GET_SNAPSHOT') {
    sendResponse({ snapshot: captionTelemetry?.snapshot() as TelemetrySnapshot | undefined });
    return false;
  }
  return false;
});
addStorageChangedListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.extensionSettings) return;
  if (!normalizeExtensionSettings(changes.extensionSettings.newValue).privacy.anonymousDiagnostics) {
    captionTelemetry?.reset();
    captionTelemetry = null;
    updateContentMainThreadLongTaskObserver();
  }
});

type ObservedCaptionBlock = {
  observer: MutationObserver;
  textNode: HTMLElement;
};

class TranscriptCollector {
  /**
   * Off until background arms it. A Meet call with captions on commits an
   * utterance every few seconds, and pushing those unconditionally would keep
   * the service worker awake for every call whether or not anything is being
   * recorded.
   */
  private capturingRunId: number | null = null;
  private readonly buffer = new CaptionBuffer({
    onCommit: (utterance) => this.pushUtterances([utterance]),
  });
  private captionObserver: MutationObserver | null = null;
  private regionObserver: MutationObserver | null = null;
  private regionParentObserver: MutationObserver | null = null;
  private meetingEndDetector: MeetingEndDetector | null = null;
  private activeRegion: HTMLElement | null = null;
  private readonly blockObservers = new WeakMap<HTMLElement, ObservedCaptionBlock>();
  private readonly observedBlocks = new Set<HTMLElement>();
  private activeBlockObserverCount = 0;

  constructor(private readonly provider: MeetingProviderAdapter) {}

  start() {
    this.observeCaptionsRegionAppearance();
    this.observeMeetingLifecycle();
    this.exposeWindowApi();
    this.exposeMessageApi();
    // This script may have loaded *into* a run already in progress — a Meet
    // reload or navigation mid-recording — in which case the arming message
    // went to the previous instance. Ask rather than stay silent until the run
    // ends.
    void this.resumeCaptureIfActive();
  }

  /** Pushes committed utterances, tagged with the run they belong to. */
  private pushUtterances(utterances: CaptionUtterance[]) {
    if (this.capturingRunId == null || !utterances.length) return;
    void trySendRuntimeMessage({
      type: 'TRANSCRIPT_UTTERANCES',
      runId: this.capturingRunId,
      utterances,
    });
  }

  /**
   * Arms or disarms shipping. Arming also flushes whatever is already
   * buffered, which closes the race between the last caption committed before
   * the arming message and the message itself. Background de-duplicates, so a
   * re-sent utterance costs nothing.
   */
  private setCapturing(runId: number | null) {
    const changed = this.capturingRunId !== runId;
    this.capturingRunId = runId;
    if (runId != null && changed) this.pushUtterances(this.buffer.getUtterances());
  }

  private async resumeCaptureIfActive() {
    try {
      const state = await chrome.runtime.sendMessage({ type: 'GET_TRANSCRIPT_CAPTURE_STATE' });
      const active = (state as TranscriptCaptureState | undefined);
      if (active?.active && typeof active.runId === 'number') this.setCapturing(active.runId);
    } catch {
      // No background to answer — nothing is recording, so nothing to resume.
    }
  }

  getTranscriptText(): string { return this.buffer.getTranscriptText(); }

  /** True when the Meet captions region is currently attached to the live DOM. */
  areCaptionsActive(): boolean { return this.activeRegion?.isConnected === true; }

  reset() {
    this.buffer.reset();
  }

  private observeCaptionsRegionAppearance() {
    const existing = this.provider.findCaptionsRegion(document);
    if (existing) { this.attachRegion(existing); return; }

    this.regionObserver?.disconnect();
    this.regionObserver = new MutationObserver(() => {
      const region = this.provider.findCaptionsRegion(document);
      if (region) this.attachRegion(region);
    });
    this.regionObserver.observe(document.body, { childList: true, subtree: true });
  }

  private attachRegion(region: HTMLElement) {
    if (this.activeRegion === region) return;

    this.regionObserver?.disconnect();
    this.regionObserver = null;
    this.captionObserver?.disconnect();
    this.regionParentObserver?.disconnect();
    this.cleanupAllSpeakerBlockObservers();
    this.activeRegion = region;

    this.regionParentObserver = new MutationObserver(() => {
      if (!this.activeRegion?.isConnected) this.onRegionRemoved();
    });
    this.regionParentObserver.observe(document.body, { childList: true, subtree: true });

    this.captionObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          for (const block of this.provider.collectCaptionBlocks(node)) {
            this.scanSpeakerBlock(block);
          }
        }
        for (const node of Array.from(m.removedNodes)) {
          if (node === this.activeRegion) { this.onRegionRemoved(); return; }
          this.cleanupSpeakerBlockObservers(node);
        }
      }
    });
    this.captionObserver.observe(region, { childList: true, subtree: true });
    this.provider.collectCaptionBlocks(region).forEach((el) => this.scanSpeakerBlock(el));
  }

  private onRegionRemoved() {
    this.captionObserver?.disconnect(); this.captionObserver = null;
    this.regionParentObserver?.disconnect(); this.regionParentObserver = null;
    this.activeRegion = null;
    this.cleanupAllSpeakerBlockObservers();
    this.observeCaptionsRegionAppearance();
  }

  private scanSpeakerBlock(block: HTMLElement) {
    const data = this.provider.getCaptionBlockData(block);
    if (!data) return;
    const { textNode: txtNode, speakerName, key } = data;

    const push = () => {
      const startedAt = nowMs();
      const trimmed = txtNode.textContent?.trim() ?? '';
      const changed = trimmed
        ? this.buffer.handleCaption(key, speakerName, trimmed)
        : false;
      const emittedAt = Number(txtNode.dataset.emittedAt);
      logPerf(console.log, 'captions', 'mutation_processed', {
        durationMs: roundMs(nowMs() - startedAt),
        sourceLatencyMs: Number.isFinite(emittedAt)
          ? Math.max(0, Date.now() - emittedAt)
          : undefined,
        changed,
        coalesced: !changed,
        textLength: trimmed.length,
      });
    };

    push();
    const existing = this.blockObservers.get(block);
    if (existing?.textNode === txtNode) return;
    existing?.observer.disconnect();

    const observer = new MutationObserver(push);
    observer.observe(txtNode, { childList: true, subtree: true, characterData: true });
    this.blockObservers.set(block, { observer, textNode: txtNode });

    if (!existing) {
      this.observedBlocks.add(block);
      this.activeBlockObserverCount += 1;
      this.reportObserverCount();
    }
  }

  private cleanupSpeakerBlockObservers(node: Node) {
    for (const block of this.provider.collectCaptionBlocks(node)) {
      const observed = this.blockObservers.get(block);
      if (!observed) continue;
      observed.observer.disconnect();
      this.blockObservers.delete(block);
      this.observedBlocks.delete(block);
      this.activeBlockObserverCount = Math.max(0, this.activeBlockObserverCount - 1);
      this.reportObserverCount();
    }
  }

  private cleanupAllSpeakerBlockObservers() {
    for (const block of Array.from(this.observedBlocks)) {
      this.blockObservers.get(block)?.observer.disconnect();
      this.blockObservers.delete(block);
    }
    this.observedBlocks.clear();
    this.activeBlockObserverCount = 0;
    this.reportObserverCount();
  }

  reportActiveBlockObserverCount() {
    logPerf(console.log, 'captions', 'observer_count', { activeBlockObservers: this.activeBlockObserverCount });
  }

  private reportObserverCount() { this.reportActiveBlockObserverCount(); }

  getActiveBlockObserverCount(): number { return this.activeBlockObserverCount; }

  private observeMeetingLifecycle() {
    this.meetingEndDetector?.stop();
    this.meetingEndDetector = new MeetingEndDetector({
      provider: this.provider,
      getMeetingId: () => this.provider.getProviderInfo(window.location, document).meetingId,
      onMeetingEnded: (payload) => this.reportMeetingEnded(payload),
    });
    this.meetingEndDetector.start();
  }

  private reportMeetingEnded(payload: MeetingEndedPayload) {
    void trySendRuntimeMessage({ type: 'MEETING_ENDED', ...payload });
  }

  private exposeWindowApi() {
    (window as any).getTranscript = () => this.getTranscriptText();
    (window as any).resetTranscript = () => this.reset();
  }

  private exposeMessageApi() {
    chrome.runtime.onMessage.addListener((
      msg: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response?: unknown) => void
    ) => {
      if (!isPopupToContentMessage(msg)) return false;
      if (msg.type === 'GET_TRANSCRIPT') {
        sendResponse({ transcript: this.getTranscriptText(), provider: this.provider.getProviderInfo(window.location, document) });
        return true;
      }
      if (msg.type === 'RESET_TRANSCRIPT') {
        this.reset();
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === 'GET_CAPTION_STATE') {
        sendResponse({ captionsActive: this.areCaptionsActive() });
        return true;
      }
      if (msg.type === 'SET_TRANSCRIPT_CAPTURE') {
        this.setCapturing(msg.active === true && typeof msg.runId === 'number' ? msg.runId : null);
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === 'GET_TRANSCRIPT_UTTERANCES') {
        sendResponse({ utterances: this.buffer.getUtterances() });
        return true;
      }
      return false;
    });
  }

  stop() {
    this.reset();
    this.captionObserver?.disconnect(); this.regionObserver?.disconnect(); this.regionParentObserver?.disconnect();
    this.captionObserver = null; this.regionObserver = null; this.regionParentObserver = null;
    this.meetingEndDetector?.stop(); this.meetingEndDetector = null;
    this.activeRegion = null;
    this.cleanupAllSpeakerBlockObservers();
  }
}

/**
 * Records long tasks (>50ms) on the Meet-tab main thread while either the local
 * development dashboard or an active anonymous diagnostics run needs them. It
 * emits one aggregate event per PerformanceObserver batch and disconnects as
 * soon as neither consumer is active.
 */
function updateContentMainThreadLongTaskObserver(): void {
  const shouldObserve = perfDebugEnabled || captionTelemetry !== null;
  if (!shouldObserve) {
    contentLongTaskObserver?.disconnect();
    contentLongTaskObserver = null;
    return;
  }
  if (contentLongTaskObserver || typeof PerformanceObserver === 'undefined') return;
  try {
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (!entries.length) return;
      let totalMs = 0;
      let maxMs = 0;
      for (const entry of entries) {
        totalMs += entry.duration;
        if (entry.duration > maxMs) maxMs = entry.duration;
      }
      logPerf(console.log, 'captions', 'long_task', {
        count: entries.length,
        totalMs: roundMs(totalMs),
        maxMs: roundMs(maxMs),
      });
    });
    observer.observe({ type: 'longtask', buffered: true });
    contentLongTaskObserver = observer;
  } catch {
    /* longtask entry type unsupported here — diagnostics-only, never fatal */
  }
}

const collector = new TranscriptCollector(new GoogleMeetAdapter());
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  (window as any).collector = collector;
} else {
  collector.start();
  void perfRuntimeReady
    .then(() => collector.reportActiveBlockObserverCount())
    .catch(() => {});
}
