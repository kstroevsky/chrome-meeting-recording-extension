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

  it('uses a total speaker tie-break so arbitrary input permutations hash identically', async () => {
    const tied: Transcript = {
      source: 'meet-captions',
      segments: [
        { tStartMs: 10, tEndMs: 20, speaker: 'Zoe', text: 'same' },
        { tStartMs: 10, tEndMs: 20, speaker: 'Ada', text: 'same' },
      ],
    };
    await expect(hashTranscript({ ...tied, segments: [...tied.segments].reverse() }))
      .resolves.toBe(await hashTranscript(tied));
  });

  it('preserves multiplicity, internal whitespace, and Unicode form in identity', async () => {
    const base: Transcript = { source: 'stt', segments: [{ tStartMs: 0, tEndMs: 1, text: 'café world' }] };
    const baseline = await hashTranscript(base);
    await expect(hashTranscript({ ...base, segments: [...base.segments, ...base.segments] })).resolves.not.toBe(baseline);
    await expect(hashTranscript({ ...base, segments: [{ ...base.segments[0], text: 'café  world' }] })).resolves.not.toBe(baseline);
    await expect(hashTranscript({ ...base, segments: [{ ...base.segments[0], text: 'cafe\u0301 world' }] })).resolves.not.toBe(baseline);
  });
});
