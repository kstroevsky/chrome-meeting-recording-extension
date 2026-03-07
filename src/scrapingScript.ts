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

import { TIMEOUTS } from './shared/timeouts';

type Chunk = {
  startTime: number;
  endTime: number;
  speaker: string;
  text: string;
};

type OpenChunk = Chunk & { timer: number };


/**
 * ⚠️  FRAGILE SELECTORS — Reverse-engineered from Google Meet's obfuscated CSS.
 *
 * These WILL break if Google updates their frontend. When captions stop working:
 *   1. Open meet.google.com and start a meeting with captions ON.
 *   2. Open DevTools → Elements and inspect an active caption bubble.
 *   3. Find the element containing the spoken text and update captionText.
 *   4. Find the element containing the speaker's name and update speakerName.
 *   5. Find the parent container (one per active speaker) and update captionBlock.
 *
 * Also check: the aria-label of the region element in observeCaptionsRegionAppearance()
 * in case Google renames the "Captions" region.
 *
 * Last verified: 2026-03
 */
const MEET_SELECTORS = {
  /** The element containing the text of what is currently being said. */
  captionText:  '.ygicle',
  /** The element containing the speaker's display name. */
  speakerName:  '.NWpY1d',
  /** The parent container for one speaker's caption block (one per active speaker). */
  captionBlock: '.nMcdL',
} as const;

function normalize(pre: string) {
  return pre
    .toLowerCase()
    .replace(/[.,?!'"\u2019]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class TranscriptCollector {
  private transcript: string[] = [];
  private prior = new Map<string, OpenChunk>();
  private lastSeen = new Map<string, string>();
  private captionObserver: MutationObserver | null = null;
  private regionObserver: MutationObserver | null = null;

  start() {
    this.observeCaptionsRegionAppearance();
    this.exposeWindowApi();
    this.exposeMessageApi();
    console.log('Transcript collector ready');
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
    const existing = document.querySelector<HTMLElement>('div[role="region"][aria-label="Captions"]');
    if (existing) {
      this.attachRegion(existing);
      return;
    }

    this.regionObserver = new MutationObserver(() => {
      const region = document.querySelector<HTMLElement>('div[role="region"][aria-label="Captions"]');
      if (region) this.attachRegion(region);
    });
    this.regionObserver.observe(document.body, { childList: true, subtree: true });
  }

  private attachRegion(region: HTMLElement) {
    this.captionObserver?.disconnect();

    this.captionObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (node instanceof HTMLElement && node.matches(MEET_SELECTORS.captionBlock)) {
            this.scanSpeakerBlock(node);
          }
        }
      }
    });

    this.captionObserver.observe(region, { childList: true, subtree: true });
    console.log('Caption observer attached');

    region.querySelectorAll<HTMLElement>(MEET_SELECTORS.captionBlock).forEach((el) => this.scanSpeakerBlock(el));
  }

  private scanSpeakerBlock(block: HTMLElement) {
    const txtNode = block.querySelector<HTMLDivElement>(MEET_SELECTORS.captionText);
    if (!txtNode) return;

    const speakerName =
      block.querySelector<HTMLElement>(MEET_SELECTORS.speakerName)?.textContent?.trim() ?? ' ';
    const key = block.getAttribute('data-participant-id') || speakerName;

    const push = () => {
      const trimmed = txtNode.textContent?.trim() ?? '';
      if (trimmed) this.handleCaption(key, speakerName, trimmed);
    };

    push();

    // Observe refinement updates
    new MutationObserver(push).observe(txtNode, {
      childList: true,
      subtree: true,
      characterData: true,
    });
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
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'GET_TRANSCRIPT') {
        sendResponse({ transcript: this.getTranscriptText() });
        return true;
      }
      if (msg?.type === 'RESET_TRANSCRIPT') {
        this.reset();
        sendResponse({ ok: true });
        return true;
      }
    });
  }

  stop() {
    this.reset();
    this.captionObserver?.disconnect();
    this.regionObserver?.disconnect();
  }
}

const collector = new TranscriptCollector();
if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
  (window as any).collector = collector;
} else {
  collector.start();
}
