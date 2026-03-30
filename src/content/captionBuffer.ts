/**
 * @file content/captionBuffer.ts
 *
 * Grace-timer buffer that accumulates live caption text per speaker and commits
 * finalized utterances after a silence window elapses.
 */

import { TIMEOUTS } from '../shared/timeouts';

type Chunk = {
  startTime: number;
  endTime: number;
  speaker: string;
  text: string;
};

type OpenChunk = Chunk & { timer: number };

/** Normalizes raw caption text for change-detection deduplication. */
export function normalizeCaptionText(pre: string): string {
  return pre
    .toLowerCase()
    .replace(/[.,?!'"\u2019]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Manages per-speaker grace timers that commit buffered caption text to the
 * final transcript after speech pauses.
 */
export class CaptionBuffer {
  private readonly prior = new Map<string, OpenChunk>();
  private readonly lastSeen = new Map<string, string>();
  private readonly transcript: string[] = [];

  /** Returns a newline-joined transcript of all committed utterances. */
  getTranscriptText(): string {
    this.flushOpenChunks();
    return this.transcript.join('\n');
  }

  /** Clears all buffered and committed transcript state. */
  reset() {
    this.prior.forEach((v) => clearTimeout(v.timer));
    this.prior.clear();
    this.lastSeen.clear();
    this.transcript.length = 0;
  }

  /**
   * Receives new caption text for a speaker. Deduplicates via normalization,
   * then restarts the speaker's grace timer on any change.
   */
  handleCaption(speakerKey: string, speakerName: string, rawText: string) {
    const text = rawText.trim();
    if (!text) return;

    const norm = normalizeCaptionText(text);
    const prev = this.lastSeen.get(speakerKey);
    if (prev === norm) return;

    this.lastSeen.set(speakerKey, norm);
    const now = Date.now();
    const existing = this.prior.get(speakerKey);

    if (!existing) {
      const timer = window.setTimeout(() => this.commit(speakerKey), TIMEOUTS.CAPTION_GRACE_MS);
      this.prior.set(speakerKey, { startTime: now, endTime: now, speaker: speakerName, text, timer });
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
}
