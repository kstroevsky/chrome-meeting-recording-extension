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
 *   4. A per-speaker timer (CAPTION_GRACE_MS) fires after silence to "commit"
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
import { TIMEOUTS } from './shared/timeouts';
import { isPopupToContentMessage } from './shared/protocol';
import { configurePerfRuntime, logPerf, type PerfEventEntry } from './shared/perf';

type Chunk = {
  startTime: number;
  endTime: number;
  speaker: string;
  text: string;
};

type OpenChunk = Chunk & { timer: number };
type ObservedCaptionBlock = {
  observer: MutationObserver;
  textNode: HTMLElement;
};

function sendPerfEvent(entry: PerfEventEntry) {
  try {
    chrome.runtime.sendMessage({ type: 'PERF_EVENT', entry }, () => {
      void chrome.runtime.lastError;
    });
  } catch {}
}

void configurePerfRuntime({
  source: 'captions',
  sink: sendPerfEvent,
});

function normalize(pre: string) {
  return pre
    .toLowerCase()
    .replace(/[.,?!'"\u2019]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class TranscriptCollector {
  constructor(private readonly provider: MeetingProviderAdapter) {}

  private transcript: string[] = [];
  private prior = new Map<string, OpenChunk>();
  private lastSeen = new Map<string, string>();
  private captionObserver: MutationObserver | null = null;
  private regionObserver: MutationObserver | null = null;
  private regionParentObserver: MutationObserver | null = null;
  private activeRegion: HTMLElement | null = null;
  private readonly blockObservers = new WeakMap<HTMLElement, ObservedCaptionBlock>();
  private readonly observedBlocks = new Set<HTMLElement>();
  private activeBlockObserverCount = 0;

  start() {
    this.observeCaptionsRegionAppearance();
    this.exposeWindowApi();
    this.exposeMessageApi();
  }

  getTranscriptText(): string {
    this.flushOpenChunks();
    return this.transcript.join('\n');
  }

  reset() {
    this.prior.forEach((v) => clearTimeout(v.timer));
    this.prior.clear();
    this.lastSeen.clear();
    this.transcript.length = 0;
  }

  private observeCaptionsRegionAppearance() {
    const existing = this.findCaptionsRegion();
    if (existing) {
      this.attachRegion(existing);
      return;
    }

    this.regionObserver?.disconnect();
    this.regionObserver = new MutationObserver(() => {
      const region = this.findCaptionsRegion();
      if (region) this.attachRegion(region);
    });
    this.regionObserver.observe(document.body, { childList: true, subtree: true });
  }

  private findCaptionsRegion(): HTMLElement | null {
    return this.provider.findCaptionsRegion(document);
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
      if (!this.activeRegion?.isConnected) {
        this.onRegionRemoved();
      }
    });
    this.regionParentObserver.observe(document.body, { childList: true, subtree: true });

    this.captionObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          for (const block of this.collectCaptionBlocks(node)) {
            this.scanSpeakerBlock(block);
          }
        }

        for (const node of Array.from(m.removedNodes)) {
          if (node === this.activeRegion) {
            this.onRegionRemoved();
            return;
          }
          this.cleanupSpeakerBlockObservers(node);
        }
      }
    });

    this.captionObserver.observe(region, { childList: true, subtree: true });

    this.provider.collectCaptionBlocks(region).forEach((el) => this.scanSpeakerBlock(el));
  }

  private onRegionRemoved() {
    this.captionObserver?.disconnect();
    this.captionObserver = null;
    this.regionParentObserver?.disconnect();
    this.regionParentObserver = null;
    this.activeRegion = null;
    this.cleanupAllSpeakerBlockObservers();
    this.observeCaptionsRegionAppearance();
  }

  private collectCaptionBlocks(node: Node): HTMLElement[] {
    return this.provider.collectCaptionBlocks(node);
  }

  private scanSpeakerBlock(block: HTMLElement) {
    const data = this.provider.getCaptionBlockData(block);
    if (!data) return;
    const { textNode: txtNode, speakerName, key } = data;

    const push = () => {
      const trimmed = txtNode.textContent?.trim() ?? '';
      if (trimmed) this.handleCaption(key, speakerName, trimmed);
    };

    push();

    const existing = this.blockObservers.get(block);
    if (existing?.textNode === txtNode) return;

    existing?.observer.disconnect();

    const observer = new MutationObserver(push);
    observer.observe(txtNode, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    this.blockObservers.set(block, { observer, textNode: txtNode });
    if (!existing) {
      this.observedBlocks.add(block);
      this.activeBlockObserverCount += 1;
      this.reportObserverCount();
    }
  }

  private cleanupSpeakerBlockObservers(node: Node) {
    for (const block of this.collectCaptionBlocks(node)) {
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
      const observed = this.blockObservers.get(block);
      observed?.observer.disconnect();
      this.blockObservers.delete(block);
    }
    this.observedBlocks.clear();
    this.activeBlockObserverCount = 0;
    this.reportObserverCount();
  }

  private reportObserverCount() {
    logPerf(console.log, 'captions', 'observer_count', {
      activeBlockObservers: this.activeBlockObserverCount,
    });
  }

  getActiveBlockObserverCount(): number {
    return this.activeBlockObserverCount;
  }

  private handleCaption(speakerKey: string, speakerName: string, rawText: string) {
    const text = rawText.trim();
    if (!text) return;

    const norm = normalize(text);
    const prev = this.lastSeen.get(speakerKey);
    if (prev === norm) return;

    this.lastSeen.set(speakerKey, norm);

    const now = Date.now();
    const existing = this.prior.get(speakerKey);

    if (!existing) {
      const timer = window.setTimeout(() => this.commit(speakerKey), TIMEOUTS.CAPTION_GRACE_MS);
      this.prior.set(speakerKey, {
        startTime: now,
        endTime: now,
        speaker: speakerName,
        text,
        timer,
      });
      return;
    }

    existing.endTime = now;
    existing.text = text;
    existing.speaker = speakerName;

    clearTimeout(existing.timer);
    existing.timer = window.setTimeout(() => this.commit(speakerKey), TIMEOUTS.CAPTION_GRACE_MS);
  }

  private commit(key: string) {
    const entry = this.prior.get(key);
    if (!entry) return;

    const startTS = new Date(entry.startTime).toISOString();
    const endTS = new Date(entry.endTime).toISOString();
    this.transcript.push(`[${startTS}] [${endTS}] ${entry.speaker} : ${entry.text}`.trim());

    clearTimeout(entry.timer);
    this.prior.delete(key);
  }

  private flushOpenChunks() {
    for (const k of Array.from(this.prior.keys())) this.commit(k);
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
        sendResponse({
          transcript: this.getTranscriptText(),
          provider: this.provider.getProviderInfo(window.location),
        });
        return true;
      }
      if (msg.type === 'RESET_TRANSCRIPT') {
        this.reset();
        sendResponse({ ok: true });
        return true;
      }
      if (msg.type === 'GET_PROVIDER_INFO') {
        sendResponse(this.provider.getProviderInfo(window.location));
        return true;
      }
      return false;
    });
  }

  stop() {
    this.reset();
    this.captionObserver?.disconnect();
    this.regionObserver?.disconnect();
    this.regionParentObserver?.disconnect();
    this.captionObserver = null;
    this.regionObserver = null;
    this.regionParentObserver = null;
    this.activeRegion = null;
    this.cleanupAllSpeakerBlockObservers();
  }
}

const collector = new TranscriptCollector(new GoogleMeetAdapter());
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  (window as any).collector = collector;
} else {
  collector.start();
}
