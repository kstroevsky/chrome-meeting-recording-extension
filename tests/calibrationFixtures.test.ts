import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadCalibrationConversations,
  loadConversation,
  mergeSpeakerTurns,
  parseTimestamp,
  parseWebVtt,
  topicOfEachUtterance,
} from './e2e/helpers/calibrationFixtures';

describe('parseTimestamp', () => {
  it('reads both WebVTT timestamp shapes', () => {
    expect(parseTimestamp('00:00:05.250')).toBe(5_250);
    expect(parseTimestamp('01:02:03.004')).toBe(3_723_004);
    expect(parseTimestamp('02:07.500')).toBe(127_500);
    // SRT uses a comma for the fraction; tools mix the two.
    expect(parseTimestamp('00:00:01,500')).toBe(1_500);
  });

  it('pads a short fraction rather than misreading it', () => {
    expect(parseTimestamp('00:00:01.5')).toBe(1_500);
  });

  it('refuses something that is not a timestamp', () => {
    expect(() => parseTimestamp('soon')).toThrow(/Not a WebVTT timestamp/);
  });
});

describe('parseWebVtt', () => {
  it('reads cues, speakers and text from a voice-span transcript', () => {
    const segments = parseWebVtt([
      'WEBVTT',
      '',
      '1',
      '00:00:00.000 --> 00:00:04.000',
      '<v Ada>the redis pool keeps saturating</v>',
      '',
      '2',
      '00:00:04.500 --> 00:00:09.000',
      '<v Grace>what timeout are we running</v>',
    ].join('\n'));

    expect(segments).toEqual([
      { tStartMs: 0, tEndMs: 4_000, speaker: 'Ada', text: 'the redis pool keeps saturating' },
      { tStartMs: 4_500, tEndMs: 9_000, speaker: 'Grace', text: 'what timeout are we running' },
    ]);
  });

  it('reads the other convention, a name prefix', () => {
    const [segment] = parseWebVtt('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nAda: we should shard it');
    expect(segment).toEqual({ tStartMs: 1_000, tEndMs: 3_000, speaker: 'Ada', text: 'we should shard it' });
  });

  it('leaves the speaker empty rather than inventing one', () => {
    // `speakerPatternChange` reads this term; a guessed attribution would
    // calibrate it against fiction.
    const [segment] = parseWebVtt('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nno speaker here');
    expect(segment.speaker).toBeUndefined();
    expect(segment.text).toBe('no speaker here');
  });

  it('keeps a colon that belongs to the sentence', () => {
    const [segment] = parseWebVtt(
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n'
      + '<v Ada>the error was: connection refused</v>',
    );
    expect(segment.speaker).toBe('Ada');
    expect(segment.text).toBe('the error was: connection refused');
  });

  it('ignores headers, notes and blank cues', () => {
    const segments = parseWebVtt([
      'WEBVTT',
      '',
      'NOTE transcribed offline',
      '',
      '00:00:01.000 --> 00:00:02.000',
      '',
      '00:00:02.000 --> 00:00:04.000',
      '<v Ada>only this one counts</v>',
    ].join('\n'));
    expect(segments.map((s) => s.text)).toEqual(['only this one counts']);
  });

  it('joins a cue split across lines', () => {
    const [segment] = parseWebVtt(
      'WEBVTT\n\n00:00:01.000 --> 00:00:05.000\n<v Ada>the pool is saturated\nand the timeout is too low</v>',
    );
    expect(segment.text).toBe('the pool is saturated and the timeout is too low');
  });
});

describe('mergeSpeakerTurns', () => {
  const cue = (tStartMs: number, tEndMs: number, speaker: string, text: string) =>
    ({ tStartMs, tEndMs, speaker, text });

  it('rebuilds a turn from the fixed-length cues a transcriber emits', () => {
    const merged = mergeSpeakerTurns([
      cue(0, 5_000, 'Ada', 'the redis pool keeps'),
      cue(5_100, 9_000, 'Ada', 'saturating under load'),
      cue(9_800, 13_000, 'Grace', 'what timeout are we running'),
    ], 1_200);

    expect(merged).toEqual([
      { tStartMs: 0, tEndMs: 9_000, speaker: 'Ada', text: 'the redis pool keeps saturating under load' },
      { tStartMs: 9_800, tEndMs: 13_000, speaker: 'Grace', text: 'what timeout are we running' },
    ]);
  });

  it('keeps a real pause between two turns of the same speaker', () => {
    const merged = mergeSpeakerTurns([
      cue(0, 5_000, 'Ada', 'first thought'),
      cue(20_000, 24_000, 'Ada', 'different thought entirely'),
    ], 1_200);
    expect(merged).toHaveLength(2);
  });

  it('does not merge across speakers, however close', () => {
    const merged = mergeSpeakerTurns([
      cue(0, 5_000, 'Ada', 'i think we should shard'),
      cue(5_050, 8_000, 'Grace', 'agreed'),
    ], 1_200);
    expect(merged).toHaveLength(2);
  });

  it('leaves an unmerged transcript untouched', () => {
    const segments = [cue(0, 1_000, 'Ada', 'one'), cue(9_000, 10_000, 'Ada', 'two')];
    expect(mergeSpeakerTurns(segments, 0)).toEqual(segments);
  });
});

describe('topicOfEachUtterance', () => {
  it('expands ranges, and lets one subject recur under one id', () => {
    const topics = topicOfEachUtterance(6, [
      { from: 0, to: 1, topic: 'redis' },
      { from: 2, to: 3, topic: 'hiring' },
      { from: 4, to: 5, topic: 'redis' },
    ]);
    expect(topics).toEqual(['redis', 'redis', 'hiring', 'hiring', 'redis', 'redis']);
  });

  it('refuses a gap, because an unlabelled utterance would score as a wrong topic', () => {
    expect(() => topicOfEachUtterance(4, [{ from: 0, to: 1, topic: 'redis' }]))
      .toThrow(/Utterance 2 has no topic label/);
  });

  it('refuses overlapping ranges rather than letting one win silently', () => {
    expect(() => topicOfEachUtterance(3, [
      { from: 0, to: 2, topic: 'redis' },
      { from: 1, to: 2, topic: 'hiring' },
    ])).toThrow(/labelled twice/);
  });

  it('refuses a range that runs off the end of the transcript', () => {
    expect(() => topicOfEachUtterance(2, [{ from: 0, to: 5, topic: 'redis' }]))
      .toThrow(/outside 0–1/);
  });
});

describe('loadConversation', () => {
  function fixture(files: Record<string, string>): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'calibration-'));
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(path.join(directory, name), contents);
    }
    return directory;
  }

  const vtt = [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:04.000',
    '<v Ada>the redis pool keeps saturating</v>',
    '',
    '00:00:04.500 --> 00:00:09.000',
    '<v Grace>flights to berlin are cheapest midweek</v>',
  ].join('\n');

  it('loads a conversation and its labels together', () => {
    const directory = fixture({
      'call.vtt': vtt,
      'call.manifest.json': JSON.stringify({
        name: 'call',
        transcript: 'call.vtt',
        topics: [{ from: 0, to: 0, topic: 'redis' }, { from: 1, to: 1, topic: 'berlin' }],
        notes: 'two subjects, one switch',
      }),
    });

    const conversation = loadConversation(path.join(directory, 'call.manifest.json'));
    expect(conversation.name).toBe('call');
    // Absent means "tune on it"; only an explicit flag holds one back.
    expect(conversation.holdout).toBe(false);
    expect(conversation.segments).toHaveLength(2);
    expect(conversation.topicOfUtterance).toEqual(['redis', 'berlin']);
    expect(conversation.notes).toBe('two subjects, one switch');
  });

  it("applies the manifest's turn merging before labels are checked", () => {
    const directory = fixture({
      'call.vtt': [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:04.000',
        '<v Ada>the redis pool keeps</v>',
        '',
        '00:00:04.200 --> 00:00:08.000',
        '<v Ada>saturating under load</v>',
      ].join('\n'),
      'call.manifest.json': JSON.stringify({
        name: 'call',
        transcript: 'call.vtt',
        mergeSpeakerTurnsWithinMs: 1_000,
        // One utterance after merging, so a two-utterance label would fail.
        topics: [{ from: 0, to: 0, topic: 'redis' }],
      }),
    });

    const conversation = loadConversation(path.join(directory, 'call.manifest.json'));
    expect(conversation.segments).toHaveLength(1);
  });

  it('reads a JSON transcript as given', () => {
    const directory = fixture({
      'call.json': JSON.stringify([
        { tStartMs: 0, tEndMs: 2_000, speaker: 'Ада', text: 'редис пул опять насыщается' },
      ]),
      'call.manifest.json': JSON.stringify({
        name: 'call',
        transcript: 'call.json',
        topics: [{ from: 0, to: 0, topic: 'redis' }],
      }),
    });

    const conversation = loadConversation(path.join(directory, 'call.manifest.json'));
    expect(conversation.segments[0].text).toBe('редис пул опять насыщается');
  });

it('marks a holdout conversation from its manifest', () => {
    const directory = fixture({
      'call.json': JSON.stringify([{ tStartMs: 0, tEndMs: 1_000, speaker: 'Ada', text: 'redis again' }]),
      'call.manifest.json': JSON.stringify({
        name: 'call',
        transcript: 'call.json',
        holdout: true,
        topics: [{ from: 0, to: 0, topic: 'redis' }],
      }),
    });
    expect(loadConversation(path.join(directory, 'call.manifest.json')).holdout).toBe(true);
  });

  it('refuses an empty transcript instead of producing an empty case', () => {
    const directory = fixture({
      'call.vtt': 'WEBVTT\n',
      'call.manifest.json': JSON.stringify({ name: 'call', transcript: 'call.vtt', topics: [] }),
    });
    expect(() => loadConversation(path.join(directory, 'call.manifest.json')))
      .toThrow(/has no utterances/);
  });
});

describe('loadCalibrationConversations', () => {
  it('answers empty when no conversations are present, rather than failing', () => {
    // Real conversations are not in the repository; a checkout without them
    // must still run every other test.
    expect(loadCalibrationConversations(path.join(tmpdir(), 'no-such-calibration-dir'))).toEqual([]);
  });

});