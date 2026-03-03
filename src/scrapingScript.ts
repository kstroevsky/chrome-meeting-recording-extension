/**
 * CONTENT SCRIPT: GOOGLE MEET CAPTION SCRAPER
 *
 * Refactor goals:
 * - isolate state + timers per speaker
 * - keep the same public API + message types
 * - reduce nesting and “spaghetti” around MutationObservers
 */

type Chunk = {
  startTime: number;
  endTime: number;
  speaker: string;
  text: string;
};

type OpenChunk = Chunk & { timer: number };

const CHUNK_GRACE_MS = 2000;

// Reverse-engineered selectors (same as original)
const captionSelector = '.ygicle';
const speakerSelector = '.NWpY1d';
const captionParent = '.nMcdL';

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
    new MutationObserver(() => {
      const region = document.querySelector<HTMLElement>('div[role="region"][aria-label="Captions"]');
      if (region) this.attachRegion(region);
    }).observe(document.body, { childList: true, subtree: true });
  }

  private attachRegion(region: HTMLElement) {
    this.captionObserver?.disconnect();

    this.captionObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (node instanceof HTMLElement && node.matches(captionParent)) {
            this.scanSpeakerBlock(node);
          }
        }
      }
    });

    this.captionObserver.observe(region, { childList: true, subtree: true });
    console.log('Caption observer attached');

    region.querySelectorAll<HTMLElement>(captionParent).forEach((el) => this.scanSpeakerBlock(el));
  }

  private scanSpeakerBlock(block: HTMLElement) {
    const txtNode = block.querySelector<HTMLDivElement>(captionSelector);
    if (!txtNode) return;

    const speakerName =
      block.querySelector<HTMLElement>(speakerSelector)?.textContent?.trim() ?? ' ';
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
      const timer = window.setTimeout(() => this.commit(speakerKey), CHUNK_GRACE_MS);
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
    existing.timer = window.setTimeout(() => this.commit(speakerKey), CHUNK_GRACE_MS);
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
}

new TranscriptCollector().start();
