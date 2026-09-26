import type { Transcript } from '../transcript';
import { hashTranscript } from '../transcriptIdentity';

describe('hashTranscript', () => {
  const transcript: Transcript = {
    source: 'meet-captions',
    segments: [
      { tStartMs: 0, tEndMs: 900, speaker: 'Alice', text: 'Hello' },
      { tStartMs: 1_000, tEndMs: 1_600, speaker: 'Bob', text: 'World' },
    ],
  };

  it('hashes the normalized transcript rather than raw ordering or whitespace', async () => {
    const equivalent: Transcript = {
      source: 'meet-captions',
      segments: [
        { tStartMs: 1_000, tEndMs: 1_600, speaker: '  Bob  ', text: '  World  ' },
        { tStartMs: 0, tEndMs: 900, speaker: ' Alice ', text: ' Hello ' },
      ],
    };

    await expect(hashTranscript(equivalent)).resolves.toBe(await hashTranscript(transcript));
  });

  it('changes when any transcript identity field changes', async () => {
    const baseline = await hashTranscript(transcript);
    const variants: Transcript[] = [
      { ...transcript, source: 'stt' },
      {
        ...transcript,
        segments: [{ ...transcript.segments[0], tStartMs: 1 }, transcript.segments[1]],
      },
      {
        ...transcript,
        segments: [{ ...transcript.segments[0], tEndMs: 901 }, transcript.segments[1]],
      },
      {
        ...transcript,
        segments: [{ ...transcript.segments[0], speaker: 'Carol' }, transcript.segments[1]],
      },
      {
        ...transcript,
        segments: [{ ...transcript.segments[0], text: 'Different' }, transcript.segments[1]],
      },
    ];

    for (const variant of variants) {
      await expect(hashTranscript(variant)).resolves.not.toBe(baseline);
    }
  });
});
