import {
  describeNotationForList,
  MAX_NOTATIONS_PER_RECORDING,
  MAX_NOTATION_TEXT_LENGTH,
  createNotationId,
  isRecordingNotationMessage,
  normalizeRecordingNotation,
  normalizeRecordingNotations,
  sortRecordingNotations,
} from '../notations';

describe('notation durable-data boundaries', () => {
  it('normalizes a valid record and trims its text', () => {
    expect(normalizeRecordingNotation({
      id: ' notation:1 ',
      tStartMs: 12_500,
      tEndMs: 41_000,
      text: '  Intro / agenda  ',
    })).toEqual({ id: 'notation:1', tStartMs: 12_500, tEndMs: 41_000, text: 'Intro / agenda' });
  });

  it('keeps a point mark with no end and no text', () => {
    expect(normalizeRecordingNotation({ id: 'notation:1', tStartMs: 0 }))
      .toEqual({ id: 'notation:1', tStartMs: 0, text: '' });
  });

  it('discards records without a usable id or start offset', () => {
    expect(normalizeRecordingNotation({ id: '  ', tStartMs: 1 })).toBeUndefined();
    expect(normalizeRecordingNotation({ id: 'notation:1' })).toBeUndefined();
    expect(normalizeRecordingNotation({ id: 'notation:1', tStartMs: -1 })).toBeUndefined();
    expect(normalizeRecordingNotation({ id: 'notation:1', tStartMs: Number.NaN })).toBeUndefined();
    expect(normalizeRecordingNotation({ id: 'notation:1', tStartMs: Infinity })).toBeUndefined();
    expect(normalizeRecordingNotation('nope')).toBeUndefined();
    expect(normalizeRecordingNotation(null)).toBeUndefined();
  });

  it('degrades an out-of-order or malformed end to a point mark rather than losing the mark', () => {
    expect(normalizeRecordingNotation({ id: 'notation:1', tStartMs: 5_000, tEndMs: 4_999, text: 'x' }))
      .toEqual({ id: 'notation:1', tStartMs: 5_000, text: 'x' });
    expect(normalizeRecordingNotation({ id: 'notation:1', tStartMs: 5_000, tEndMs: 'later', text: 'x' }))
      .toEqual({ id: 'notation:1', tStartMs: 5_000, text: 'x' });
  });

  it('allows a zero-length span', () => {
    expect(normalizeRecordingNotation({ id: 'notation:1', tStartMs: 5_000, tEndMs: 5_000, text: '' }))
      .toEqual({ id: 'notation:1', tStartMs: 5_000, tEndMs: 5_000, text: '' });
  });

  it('bounds notation text', () => {
    const notation = normalizeRecordingNotation({ id: 'notation:1', tStartMs: 0, text: 'a'.repeat(600) });
    expect(notation?.text).toHaveLength(MAX_NOTATION_TEXT_LENGTH);
  });

  it('coerces non-string text to empty', () => {
    expect(normalizeRecordingNotation({ id: 'notation:1', tStartMs: 0, text: 42 })?.text).toBe('');
  });
});

describe('endedBy', () => {
  it('keeps a valid end reason alongside an end', () => {
    expect(normalizeRecordingNotation({ id: 'n', tStartMs: 0, tEndMs: 5, endedBy: 'auto', text: '' }))
      .toEqual({ id: 'n', tStartMs: 0, tEndMs: 5, endedBy: 'auto', text: '' });
    expect(normalizeRecordingNotation({ id: 'n', tStartMs: 0, tEndMs: 5, endedBy: 'user', text: '' })?.endedBy)
      .toBe('user');
  });

  it('drops an end reason on a span with no end \u2014 it would describe nothing', () => {
    expect(normalizeRecordingNotation({ id: 'n', tStartMs: 0, endedBy: 'auto', text: '' }))
      .toEqual({ id: 'n', tStartMs: 0, text: '' });
    // Also when the end itself was rejected for being out of order.
    expect(normalizeRecordingNotation({ id: 'n', tStartMs: 9, tEndMs: 1, endedBy: 'auto', text: '' }))
      .toEqual({ id: 'n', tStartMs: 9, text: '' });
  });

  it('drops an unrecognized end reason', () => {
    expect(normalizeRecordingNotation({ id: 'n', tStartMs: 0, tEndMs: 5, endedBy: 'magic', text: '' })?.endedBy)
      .toBeUndefined();
  });
});

describe('normalizeRecordingNotations', () => {
  it('skips invalid records and returns chronological order', () => {
    expect(normalizeRecordingNotations([
      { id: 'notation:b', tStartMs: 9_000, text: 'second' },
      { id: '', tStartMs: 1_000, text: 'dropped' },
      { id: 'notation:a', tStartMs: 1_000, text: 'first' },
      'nonsense',
    ])).toEqual([
      { id: 'notation:a', tStartMs: 1_000, text: 'first' },
      { id: 'notation:b', tStartMs: 9_000, text: 'second' },
    ]);
  });

  it('returns an empty list for non-array input', () => {
    expect(normalizeRecordingNotations(undefined)).toEqual([]);
    expect(normalizeRecordingNotations({ id: 'notation:1' })).toEqual([]);
  });

  it('bounds the list length', () => {
    const oversized = Array.from({ length: MAX_NOTATIONS_PER_RECORDING + 20 }, (_, index) => ({
      id: `notation:${index}`,
      tStartMs: index,
      text: '',
    }));
    expect(normalizeRecordingNotations(oversized)).toHaveLength(MAX_NOTATIONS_PER_RECORDING);
  });
});

describe('sortRecordingNotations', () => {
  it('breaks ties on id so repeated reads agree, without mutating the input', () => {
    const input = [
      { id: 'notation:b', tStartMs: 1_000, text: '' },
      { id: 'notation:a', tStartMs: 1_000, text: '' },
    ];
    expect(sortRecordingNotations(input).map((notation) => notation.id)).toEqual(['notation:a', 'notation:b']);
    expect(input.map((notation) => notation.id)).toEqual(['notation:b', 'notation:a']);
  });
});

describe('createNotationId', () => {
  it('namespaces the generated id', () => {
    expect(createNotationId()).toMatch(/^notation:.+/);
    expect(createNotationId()).not.toBe(createNotationId());
  });
});

describe('isRecordingNotationMessage', () => {
  it('accepts well-formed messages', () => {
    expect(isRecordingNotationMessage({ type: 'MARK_NOTATION' })).toBe(true);
    expect(isRecordingNotationMessage({ type: 'MARK_NOTATION', text: 'demo starts' })).toBe(true);
    expect(isRecordingNotationMessage({ type: 'END_NOTATION', id: 'notation:1' })).toBe(true);
    expect(isRecordingNotationMessage({ type: 'LIST_RECORDING_NOTATIONS', recordingId: 'recording:1' })).toBe(true);
    expect(isRecordingNotationMessage({ type: 'ADD_RECORDING_NOTATION', recordingId: 'recording:1', tStartMs: 0, text: '' })).toBe(true);
    expect(isRecordingNotationMessage({ type: 'UPDATE_RECORDING_NOTATION', recordingId: 'recording:1', id: 'notation:1' })).toBe(true);
    expect(isRecordingNotationMessage({ type: 'REMOVE_RECORDING_NOTATION', recordingId: 'recording:1', id: 'notation:1' })).toBe(true);
  });

  it('rejects malformed messages', () => {
    expect(isRecordingNotationMessage({ type: 'MARK_NOTATION', text: 7 })).toBe(false);
    expect(isRecordingNotationMessage({ type: 'END_NOTATION' })).toBe(false);
    expect(isRecordingNotationMessage({ type: 'LIST_RECORDING_NOTATIONS', recordingId: '' })).toBe(false);
    expect(isRecordingNotationMessage({ type: 'ADD_RECORDING_NOTATION', recordingId: 'recording:1', text: '' })).toBe(false);
    expect(isRecordingNotationMessage({ type: 'ADD_RECORDING_NOTATION', recordingId: 'recording:1', tStartMs: -1, text: '' })).toBe(false);
    expect(isRecordingNotationMessage({ type: 'UPDATE_RECORDING_NOTATION', recordingId: 'recording:1', id: 'notation:1', tStartMs: 'soon' })).toBe(false);
    expect(isRecordingNotationMessage({ type: 'REMOVE_RECORDING_NOTATION', recordingId: 'recording:1' })).toBe(false);
    expect(isRecordingNotationMessage({ type: 'SET_RECORDING_HISTORY_NOTE', id: 'recording:1', note: '' })).toBe(false);
    expect(isRecordingNotationMessage(null)).toBe(false);
  });
});

describe('describeNotationForList', () => {
  const fmt = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

  it('uses the note\u2019s own message when it has one', () => {
    expect(describeNotationForList({ id: 'n', tStartMs: 0, tEndMs: 1_000, text: 'Pricing objection' }, fmt))
      .toBe('Pricing objection');
  });

  it('keeps an unnamed note in place, labelled by its length', () => {
    expect(describeNotationForList({ id: 'n', tStartMs: 1_082_000, tEndMs: 1_130_000, text: '' }, fmt))
      .toBe('Unnamed \u00b7 0:48');
  });

  it('says only Unnamed when the span never closed', () => {
    expect(describeNotationForList({ id: 'n', tStartMs: 1_000, text: '' }, fmt)).toBe('Unnamed');
  });
});
