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
 * @see src/shared/protocol.ts  — GET_TRANSCRIPT / RESET_TRANSCRIPT types
 * @see src/shared/timeouts.ts  — CAPTION_GRACE_MS constant
 */

import { GoogleMeetAdapter } from './content/GoogleMeetAdapter';
import type { MeetingProviderAdapter } from './content/MeetingProviderAdapter';
import { trySendRuntimeMessage } from './platform/chrome/runtime';
import { isPopupToContentMessage } from './shared/protocol';
import {
  configurePerfRuntime,
  isPerfDebugMode,
  logPerf,
  nowMs,
  roundMs,
  type PerfEventEntry,
} from './shared/perf';
import { CaptionBuffer } from './content/captionBuffer';
import { MeetingEndDetector, type MeetingEndedPayload } from './content/MeetingEndDetector';

function sendPerfEvent(entry: PerfEventEntry) {
  void trySendRuntimeMessage({ type: 'PERF_EVENT', entry });
}

void configurePerfRuntime({ source: 'captions', sink: sendPerfEvent });

type ObservedCaptionBlock = {
  observer: MutationObserver;
  textNode: HTMLElement;
};

class TranscriptCollector {
  private readonly buffer = new CaptionBuffer();
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

  private reportObserverCount() {
    logPerf(console.log, 'captions', 'observer_count', { activeBlockObservers: this.activeBlockObserverCount });
  }

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
 * Debug-only: records long tasks (>50ms) on the Meet-tab main thread so the
 * diagnostics snapshot can show whether content-script work (caption processing)
 * actually blocks the user-facing tab — the one metric the offscreen
 * RuntimeSampler cannot see. Emits one aggregate event per PerformanceObserver
 * batch (not per entry) to bound its own overhead, and only in debug builds so
 * production pays nothing. See PerfDebugSummary.captions.longTask*.
 */
function observeContentMainThreadLongTasks(): void {
  if (!isPerfDebugMode()) return;
  if (typeof PerformanceObserver === 'undefined') return;
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
  } catch {
    /* longtask entry type unsupported here — diagnostics-only, never fatal */
  }
}

const collector = new TranscriptCollector(new GoogleMeetAdapter());
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  (window as any).collector = collector;
} else {
  collector.start();
  observeContentMainThreadLongTasks();
}
