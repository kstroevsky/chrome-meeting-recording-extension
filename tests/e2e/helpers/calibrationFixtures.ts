/**
 * @file calibrationFixtures.ts
 *
 * Turns a **real conversation** into a 4B calibration case: timed, speaker-
 * attributed utterances plus hand labels for where topics change and which
 * stretches are the same topic.
 *
 * The synthetic corpus in `calibrationCorpus.ts` built both halves itself,
 * which is exactly why its numbers are candidates rather than contracts —
 * generated topic blocks have none of the interruptions, callbacks, weak
 * transitions or shared vocabulary that decide a threshold. These fixtures come
 * from outside instead, so nothing about the conversation is chosen by the
 * thing being calibrated.
 *
 * **Both label kinds are recorded, and they are not the same thing.** A range
 * boundary says *a topic changed here*; a range's `topic` id says *this stretch
 * is that subject again*. Segmentation is scored on the first, clustering on
 * the second, and a pipeline can be good at one and useless at the other —
 * which is the whole reason topics are global and segments are temporal.
 *
 * See `tests/fixtures/calibration/README.md` for the on-disk format.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { TranscriptSegment } from '../../../src/shared/transcript';

/** One labelled stretch: utterance indices, inclusive, and the subject. */
export type TopicRange = { from: number; to: number; topic: string };

export type CalibrationManifest = {
  name: string;
  /** Transcript file beside the manifest: `.vtt`, or `.json` in this shape. */
  transcript: string;
  topics: TopicRange[];
  /**
   * Held out of tuning, and reported on its own.
   *
   * With a corpus this small, thresholds picked and reported on the same calls
   * look far more certain than the evidence warrants. A flag rather than a note
   * because the grid must be able to *enforce* the split, not be trusted to
   * honour a sentence in prose.
   */
  holdout?: boolean;
  /**
   * Joins consecutive cues from one speaker separated by less than this.
   *
   * Off unless set, and set deliberately: an ASR tool emits fixed-length cues
   * (often ~5 s) while the pipeline's windows are *turns*, so four raw Whisper
   * cues can be twenty seconds of one person's sentence rather than four turns.
   * Calibrating window size against cue-shaped input would tune for a shape the
   * product never sees. A value near a second usually recovers turns; the right
   * one depends on the tool, which is why it lives per conversation.
   */
  mergeSpeakerTurnsWithinMs?: number;
  /** Anything worth knowing when reading results: shape, source, language. */
  notes?: string;
};

export type CalibrationConversation = {
  name: string;
  segments: TranscriptSegment[];
  /** The true topic of each utterance, by index — derived from `topics`. */
  topicOfUtterance: string[];
  /** True for the conversation the grid never sees. */
  holdout: boolean;
  notes?: string;
};

/** `HH:MM:SS.mmm` or `MM:SS.mmm` → milliseconds. */
export function parseTimestamp(value: string): number {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match) throw new Error(`Not a WebVTT timestamp: ${value}`);
  const [, hours, minutes, seconds, fraction] = match;
  return ((Number(hours ?? 0) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
    + Number(fraction.padEnd(3, '0'));
}

/**
 * Parses WebVTT into utterances, keeping speakers.
 *
 * Handles the two speaker conventions transcription tools actually emit: a
 * `<v Name>` voice span, and a `Name:` prefix. A cue with neither keeps an
 * empty speaker rather than guessing — `speakerPatternChange` reads this, so an
 * invented attribution would calibrate that term against fiction.
 */
export function parseWebVtt(text: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim());
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue; // WEBVTT header, NOTE, or a stray cue id
    const [rawStart, rawEnd] = lines[timingIndex].split('-->').map((part) => part.trim().split(/\s+/)[0]);
    const body = lines.slice(timingIndex + 1).join(' ').trim();
    if (!body) continue;

    let speaker = '';
    let content = body;
    const voice = /^<v\s+([^>]+)>([\s\S]*?)(?:<\/v>)?$/.exec(body);
    if (voice) {
      speaker = voice[1].trim();
      content = voice[2].trim();
    } else {
      const prefixed = /^([^:]{1,40}):\s+(.*)$/.exec(body);
      if (prefixed) {
        speaker = prefixed[1].trim();
        content = prefixed[2].trim();
      }
    }
    if (!content) continue;

    segments.push({
      tStartMs: parseTimestamp(rawStart),
      tEndMs: parseTimestamp(rawEnd),
      ...(speaker ? { speaker } : {}),
      text: content,
    });
  }
  return segments;
}

/**
 * Joins consecutive utterances by one speaker that are close together, so the
 * fixture is turn-shaped rather than cue-shaped. See `mergeSpeakerTurnsWithinMs`.
 */
export function mergeSpeakerTurns(segments: TranscriptSegment[], withinMs: number): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    const sameSpeaker = previous && (previous.speaker ?? '') === (segment.speaker ?? '');
    if (previous && sameSpeaker && segment.tStartMs - previous.tEndMs <= withinMs) {
      previous.text = `${previous.text} ${segment.text}`.trim();
      previous.tEndMs = segment.tEndMs;
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

/** Expands labelled ranges into one topic id per utterance. */
export function topicOfEachUtterance(count: number, ranges: TopicRange[]): string[] {
  const topics = new Array<string>(count).fill('');
  for (const range of ranges) {
    if (range.from < 0 || range.to >= count || range.to < range.from) {
      throw new Error(`Topic range ${range.from}–${range.to} ("${range.topic}") is outside 0–${count - 1}`);
    }
    for (let i = range.from; i <= range.to; i += 1) {
      if (topics[i]) throw new Error(`Utterance ${i} is labelled twice: "${topics[i]}" and "${range.topic}"`);
      topics[i] = range.topic;
    }
  }
  const unlabelled = topics.findIndex((topic) => !topic);
  if (unlabelled !== -1) throw new Error(`Utterance ${unlabelled} has no topic label`);
  return topics;
}

/** Loads one conversation from a manifest and its transcript. */
export function loadConversation(manifestPath: string): CalibrationConversation {
  const manifest: CalibrationManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const transcriptPath = path.resolve(path.dirname(manifestPath), manifest.transcript);
  const raw = readFileSync(transcriptPath, 'utf8');

  let segments = transcriptPath.endsWith('.json')
    ? (JSON.parse(raw) as TranscriptSegment[])
    : parseWebVtt(raw);
  if (manifest.mergeSpeakerTurnsWithinMs != null) {
    segments = mergeSpeakerTurns(segments, manifest.mergeSpeakerTurnsWithinMs);
  }
  if (!segments.length) throw new Error(`${manifest.name}: transcript has no utterances`);

  return {
    name: manifest.name,
    segments,
    topicOfUtterance: topicOfEachUtterance(segments.length, manifest.topics),
    holdout: manifest.holdout === true,
    ...(manifest.notes ? { notes: manifest.notes } : {}),
  };
}

export const CALIBRATION_FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/calibration');

/** Every conversation on disk, in name order. Empty when none are present. */
export function loadCalibrationConversations(directory = CALIBRATION_FIXTURE_DIR): CalibrationConversation[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.manifest.json'))
    .sort()
    .map((entry) => loadConversation(path.join(directory, entry)));
}
