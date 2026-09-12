/**
 * @file content/captionBuffer.ts
 *
 * Grace-timer buffer that accumulates live caption text per speaker and commits
 * finalized utterances after a silence window elapses.
 *
 * Committed utterances are kept as {@link CaptionUtterance} records rather than
 * pre-joined strings, so the same buffer can answer both the popup's `.txt`
 * download and the transcript aggregate (ADR-0007 Decision 1). The rendered
 * text is a *view* of those records, and its format is unchanged.
 *
 * Times here are wall clock, which is the only clock this context has: the Meet
 * tab does not know a recording exists, or whether it is paused. Background
 * projects them onto the media timeline — see `shared/transcript.ts`.
 */

import { TIMEOUTS } from '../shared/timeouts';
import type { CaptionUtterance } from '../shared/transcript';

type OpenChunk = CaptionUtterance & { timer: number };

/** Normalizes raw caption text for change-detection deduplication. */
export function normalizeCaptionText(pre: string): string {
  return pre
    .toLowerCase()
    .replace(/[.,?!'"’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Renders one committed utterance in the transcript download's line format. */
export function renderCaptionLine(utterance: CaptionUtterance): string {
  const startTS = new Date(utterance.startWallMs).toISOString();
  const endTS = new Date(utterance.endWallMs).toISOString();
  return `[${startTS}] [${endTS}] ${utterance.speaker} : ${utterance.text}`.trim();
}

export type CaptionBufferOptions = {
  /**
   * Called as each utterance is committed, so background can persist the
   * transcript incrementally. Captions are ephemeral and the Meet tab can close
   * before a recording finalizes, so nothing waits until stop to ship them.
   */
  onCommit?: (utterance: CaptionUtterance) => void;
};

/**
 * Manages per-speaker grace timers that commit buffered caption text to the
 * final transcript after speech pauses.
 */
export class CaptionBuffer {
  private readonly prior = new Map<string, OpenChunk>();
  private readonly lastSeen = new Map<string, string>();
  private readonly committed: CaptionUtterance[] = [];
  private readonly onCommit?: (utterance: CaptionUtterance) => void;

  constructor(options: CaptionBufferOptions = {}) {
    this.onCommit = options.onCommit;
  }

  /** Returns a newline-joined transcript of all committed utterances. */
  getTranscriptText(): string {
    return this.getUtterances().map(renderCaptionLine).join('\n');
  }

  /**
   * Returns every committed utterance, flushing anything still inside its grace
   * window first — a caller asking for the transcript wants the words already
   * spoken, not only the ones that have gone quiet long enough.
   */
  getUtterances(): CaptionUtterance[] {
    this.flushOpenChunks();
    return this.committed.map((utterance) => ({ ...utterance }));
  }

  /** Clears all buffered and committed transcript state. */
  reset() {
    this.prior.forEach((v) => clearTimeout(v.timer));
    this.prior.clear();
    this.lastSeen.clear();
    this.committed.length = 0;
  }

  /**
   * Receives new caption text for a speaker. Deduplicates via normalization,
   * then restarts the speaker's grace timer on any change.
   */
  handleCaption(speakerKey: string, speakerName: string, rawText: string): boolean {
    const text = rawText.trim();
    if (!text) return false;

    const norm = normalizeCaptionText(text);
    const prev = this.lastSeen.get(speakerKey);
    if (prev === norm) return false;

    this.lastSeen.set(speakerKey, norm);
    const now = Date.now();
    const existing = this.prior.get(speakerKey);

    if (!existing) {
      const timer = window.setTimeout(() => this.commit(speakerKey), TIMEOUTS.CAPTION_GRACE_MS);
      this.prior.set(speakerKey, { startWallMs: now, endWallMs: now, speaker: speakerName, text, timer });
      return true;
    }

    existing.endWallMs = now;
    existing.text = text;
    existing.speaker = speakerName;
    clearTimeout(existing.timer);
    existing.timer = window.setTimeout(() => this.commit(speakerKey), TIMEOUTS.CAPTION_GRACE_MS);
    return true;
  }

  private commit(key: string) {
    const entry = this.prior.get(key);
    if (!entry) return;
    const { timer, ...utterance } = entry;
    this.committed.push(utterance);
    clearTimeout(timer);
    this.prior.delete(key);
    // A listener that throws must not strand the buffer or the grace timers.
    try {
      this.onCommit?.({ ...utterance });
    } catch {}
  }

  private flushOpenChunks() {
    for (const k of Array.from(this.prior.keys())) this.commit(k);
  }
}
