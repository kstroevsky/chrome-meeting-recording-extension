import type { Transcript } from '../shared/transcript';
import type { IntegrationSpeakerAlias } from './persistence';
import { sha256Hex } from './serialization';

export type SpeakerPseudonymProjection = {
  bySpeaker: ReadonlyMap<string, string>;
  durable: IntegrationSpeakerAlias[];
};

/**
 * Extends the destination/recording-scoped pseudonym table without persisting
 * raw speaker names. Existing ordinals never move, even when a later transcript
 * revision backfills a previously unseen speaker before them.
 */
export async function extendSpeakerPseudonyms(
  transcript: Transcript,
  externalRecordingId: string,
  current: readonly IntegrationSpeakerAlias[] = [],
): Promise<SpeakerPseudonymProjection> {
  const byHash = new Map(current.map((entry) => [entry.speakerHash, entry.ordinal]));
  let nextOrdinal = current.reduce((max, entry) => Math.max(max, entry.ordinal), 0) + 1;
  const speakers = [...new Set(
    transcript.segments
      .map((segment) => segment.speaker)
      .filter((speaker): speaker is string => Boolean(speaker)),
  )];
  const hashes = await Promise.all(speakers.map((speaker) => speakerHash(externalRecordingId, speaker)));
  const bySpeaker = new Map<string, string>();

  for (let index = 0; index < speakers.length; index += 1) {
    const hash = hashes[index];
    let ordinal = byHash.get(hash);
    if (ordinal == null) {
      ordinal = nextOrdinal++;
      byHash.set(hash, ordinal);
    }
    bySpeaker.set(speakers[index], `Speaker ${ordinal}`);
  }

  return {
    bySpeaker,
    durable: [...byHash.entries()]
      .map(([speakerHash, ordinal]) => ({ speakerHash, ordinal }))
      .sort((left, right) => left.ordinal - right.ordinal || left.speakerHash.localeCompare(right.speakerHash)),
  };
}

async function speakerHash(externalRecordingId: string, speaker: string): Promise<string> {
  return sha256Hex(`${externalRecordingId}\u0000${speaker}`);
}
