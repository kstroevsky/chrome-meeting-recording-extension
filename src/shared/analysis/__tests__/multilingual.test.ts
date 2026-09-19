/**
 * The multilingual pass (plan §11 item 7, D-18).
 *
 * The encoder is deliberately multilingual and this project's own user speaks
 * Russian and Ukrainian, so "does it degrade gracefully" is not a hypothetical
 * here — it is the common case. These run the *whole* pipeline over non-Latin
 * transcripts with a stub encoder, which is enough to prove every stage above
 * the model handles the script: window cues, Unicode word boundaries, c-TF-IDF
 * tokenization, and readable labels.
 */
import { analyzeTranscript } from '../analyzeTranscript';
import { tokenize, topicLabels } from '../keywords';
import { startsWithDiscourseCue, type AnalysisConfig } from '../types';
import { discourseSignal } from '../importance';
import { CANDIDATE_ANALYSIS_CONFIG } from '../candidateConfig';
import type { TranscriptSegment } from '../../transcript';

const CONFIG: AnalysisConfig = { ...CANDIDATE_ANALYSIS_CONFIG, assignmentThreshold: 0.93, minSegmentMs: 1_000 };

/** Subject-keyed stub: text about one subject points one way, in any script. */
function encoderFor(subjects: Record<string, number>) {
  return async (texts: string[]): Promise<Float32Array[]> => texts.map((text) => {
    const found = Object.keys(subjects).find((key) => text.includes(key)) ?? Object.keys(subjects)[0];
    const rad = (subjects[found] * Math.PI) / 180;
    return Float32Array.from([Math.cos(rad), Math.sin(rad)]);
  });
}

function transcriptOf(schedule: Array<[string, string, number]>): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let clock = 0;
  for (const [, phrase, count] of schedule) {
    for (let i = 0; i < count; i += 1) {
      segments.push({
        tStartMs: clock,
        tEndMs: clock + 2_000,
        speaker: i % 2 ? 'Оля' : 'Дмитро',
        text: `${phrase} ${i}`,
      });
      clock += 3_000;
    }
  }
  return segments;
}

describe('tokenize across scripts', () => {
  it('keeps Cyrillic terms instead of discarding them', () => {
    expect(tokenize('Редис пул таймаут, воркеры!')).toEqual(['редис', 'пул', 'таймаут', 'воркеры']);
  });

  it('keeps Ukrainian letters absent from the Russian alphabet', () => {
    expect(tokenize('черга їхні підхід ґанок')).toEqual(['черга', 'їхні', 'підхід', 'ґанок']);
  });

  it('handles a script with no spaces without inventing terms', () => {
    // Japanese tokenizes as one run — wrong for retrieval, but it does not
    // crash and it does not silently produce an empty label.
    expect(tokenize('レディスプール')).toEqual(['レディスプール']);
  });

  it('still drops punctuation residue and single characters', () => {
    expect(tokenize('а и — redis?')).toEqual(['redis']);
  });
});

describe('discourse cues across languages (D-18)', () => {
  it('fires on Russian and Ukrainian openers', () => {
    expect(startsWithDiscourseCue('Кстати, про редис')).toBe(true);
    expect(startsWithDiscourseCue('До речі, щодо черги')).toBe(true);
    expect(startsWithDiscourseCue('Наступне питання')).toBe(true);
  });

  it('respects the word boundary in Cyrillic, not only in ASCII', () => {
    expect(startsWithDiscourseCue('кстатиь про редис')).toBe(false);
    expect(startsWithDiscourseCue('загаломний підхід')).toBe(false);
  });

  it('contributes nothing for a language outside the list, rather than failing', () => {
    // German: no cue fires, so the blend runs 0.70/0.10/0.10/0.00. The claim is
    // that this is a *degraded* signal, not an error.
    expect(startsWithDiscourseCue('Übrigens, zum Thema Redis')).toBe(false);
    expect(() => startsWithDiscourseCue('Übrigens')).not.toThrow();
  });

  it('scores Russian and Ukrainian importance signals', () => {
    const passage = (text: string) => ({ id: 'p', tStartMs: 0, tEndMs: 1, text, embedding: Float32Array.from([1, 0]) });
    expect(discourseSignal(passage('мы договорились начать в среду'))).toBeGreaterThan(0);
    expect(discourseSignal(passage('ми домовилися почати в середу'))).toBeGreaterThan(0);
    expect(discourseSignal(passage('погода сегодня хорошая'))).toBe(0);
  });
});

describe('the pipeline over a Russian conversation', () => {
  const encode = encoderFor({ редис: 0, берлін: 90, берлин: 90, найм: 180 });

  it('produces segments and topics labelled in the language spoken', async () => {
    const result = await analyzeTranscript(
      transcriptOf([
        ['redis', 'редис пул таймаут воркеры', 12],
        ['berlin', 'берлин отель рейс виза', 12],
        ['hiring', 'найм собеседование кандидат фронтенд', 12],
      ]),
      CONFIG,
      encode,
    );

    expect(result.topics.length).toBeGreaterThan(1);
    const labels = result.topics.flatMap((topic) => topic.keywords);
    expect(labels.length).toBeGreaterThan(0);
    // Labels are Cyrillic, not empty and not mojibake.
    expect(labels.every((term) => /^[\p{Letter}\p{Number}]+$/u.test(term))).toBe(true);
    expect(labels.some((term) => /[Ѐ-ӿ]/.test(term))).toBe(true);
  });

  it('reunites a Russian subject the conversation returns to (MODEL-04)', async () => {
    const result = await analyzeTranscript(
      transcriptOf([
        ['redis', 'редис пул таймаут', 12],
        ['berlin', 'берлин отель рейс', 12],
        ['redis', 'редис пул таймаут', 12],
      ]),
      CONFIG,
      encode,
    );

    expect(result.segments.length).toBeGreaterThan(result.topics.length);
  });
});

describe('the pipeline over a Ukrainian conversation', () => {
  it('runs end to end and names its topics', async () => {
    const result = await analyzeTranscript(
      transcriptOf([
        ['queue', 'черга завдання обробка затримка', 12],
        ['release', 'реліз випуск дата тестування', 12],
      ]),
      CONFIG,
      encoderFor({ черга: 0, реліз: 90 }),
    );

    expect(result.topics.length).toBeGreaterThan(0);
    expect(result.topics.every((topic) => topic.keywords.length > 0)).toBe(true);
  });
});

describe('c-TF-IDF label selection across scripts', () => {
  it('drops a term every topic shares, in Cyrillic as in English', () => {
    const labels = topicLabels(
      [
        { id: 'a', text: 'проект редис пул таймаут проект' },
        { id: 'b', text: 'проект берлин отель рейс проект' },
      ],
      { keywordsPerTopic: 3 },
    );

    // "проект" is in every topic, so it names none of them.
    for (const terms of labels.values()) expect(terms).not.toContain('проект');
    expect(labels.get('a')).toContain('редис');
  });

  it('labels a mixed-language conversation without preferring one script', () => {
    const labels = topicLabels(
      [
        { id: 'a', text: 'редис pool таймаут redis' },
        { id: 'b', text: 'берлин hotel рейс flight' },
      ],
      { keywordsPerTopic: 4 },
    );

    expect(labels.get('a')!.length).toBeGreaterThan(0);
    expect(labels.get('b')!.length).toBeGreaterThan(0);
  });
});
