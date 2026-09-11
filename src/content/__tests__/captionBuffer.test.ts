import { CaptionBuffer, normalizeCaptionText, renderCaptionLine } from '../captionBuffer';
import { TIMEOUTS } from '../../shared/timeouts';
import type { CaptionUtterance } from '../../shared/transcript';

const GRACE = TIMEOUTS.CAPTION_GRACE_MS;

describe('caption text normalization', () => {
  it('lowercases, strips terminal punctuation and collapses whitespace for dedupe', () => {
    expect(normalizeCaptionText("  So, the POOL is saturated!  ")).toBe('so the pool is saturated');
    expect(normalizeCaptionText('it’s fine')).toBe('its fine');
  });
});

describe('CaptionBuffer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-11T10:00:00.000Z'));
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('commits an utterance once its speaker has gone quiet for the grace window', () => {
    const buffer = new CaptionBuffer();
    const spokenAt = Date.now();
    buffer.handleCaption('s1', 'Ada', 'the pool is saturated');
    expect(buffer.getUtterances()).toHaveLength(1);

    jest.advanceTimersByTime(GRACE);
    expect(buffer.getUtterances()).toEqual([
      { startWallMs: spokenAt, endWallMs: spokenAt, speaker: 'Ada', text: 'the pool is saturated' },
    ]);
  });

  it('extends an open utterance as its text is refined, keeping one record', () => {
    const buffer = new CaptionBuffer();
    const startWallMs = Date.now();
    buffer.handleCaption('s1', 'Ada', 'the pool');
    jest.advanceTimersByTime(500);
    buffer.handleCaption('s1', 'Ada', 'the pool is saturated');
    jest.advanceTimersByTime(GRACE);

    expect(buffer.getUtterances()).toEqual([
      { startWallMs, endWallMs: startWallMs + 500, speaker: 'Ada', text: 'the pool is saturated' },
    ]);
  });

  it('ignores a repeat that only differs by punctuation or case', () => {
    const buffer = new CaptionBuffer();
    expect(buffer.handleCaption('s1', 'Ada', 'the pool is saturated')).toBe(true);
    expect(buffer.handleCaption('s1', 'Ada', 'The pool is saturated.')).toBe(false);
    expect(buffer.handleCaption('s1', 'Ada', '   ')).toBe(false);
  });

  it('keeps concurrent speakers in separate utterances', () => {
    const buffer = new CaptionBuffer();
    buffer.handleCaption('s1', 'Ada', 'i think we should shard');
    buffer.handleCaption('s2', 'Grace', 'what about the timeout');
    jest.advanceTimersByTime(GRACE);

    expect(buffer.getUtterances().map((u) => u.speaker).sort()).toEqual(['Ada', 'Grace']);
  });

  it('flushes still-open utterances when the transcript is read', () => {
    const buffer = new CaptionBuffer();
    buffer.handleCaption('s1', 'Ada', 'mid sentence');
    // No grace window has elapsed, but a caller asking for the transcript wants
    // the words already spoken.
    expect(buffer.getUtterances()).toHaveLength(1);
    jest.advanceTimersByTime(GRACE);
    expect(buffer.getUtterances()).toHaveLength(1);
  });

  it('renders the download text in the established line format', () => {
    const buffer = new CaptionBuffer();
    buffer.handleCaption('s1', 'Ada', 'the pool is saturated');
    jest.advanceTimersByTime(GRACE);

    expect(buffer.getTranscriptText()).toBe(
      '[2026-09-11T10:00:00.000Z] [2026-09-11T10:00:00.000Z] Ada : the pool is saturated',
    );
  });

  it('trims a rendered line when the speaker is unknown', () => {
    expect(renderCaptionLine({ startWallMs: 0, endWallMs: 0, speaker: '', text: 'hello' }))
      .toBe('[1970-01-01T00:00:00.000Z] [1970-01-01T00:00:00.000Z]  : hello');
  });

  it('reports each commit so background can persist incrementally', () => {
    const committed: CaptionUtterance[] = [];
    const buffer = new CaptionBuffer({ onCommit: (u) => committed.push(u) });
    buffer.handleCaption('s1', 'Ada', 'first');
    jest.advanceTimersByTime(GRACE);
    buffer.handleCaption('s1', 'Ada', 'second');
    jest.advanceTimersByTime(GRACE);

    expect(committed.map((u) => u.text)).toEqual(['first', 'second']);
  });

  it('survives a commit listener that throws', () => {
    const buffer = new CaptionBuffer({ onCommit: () => { throw new Error('port closed'); } });
    buffer.handleCaption('s1', 'Ada', 'first');
    expect(() => jest.advanceTimersByTime(GRACE)).not.toThrow();
    // The utterance is still committed locally, so the `.txt` download is intact
    // even when the background channel is gone.
    expect(buffer.getUtterances().map((u) => u.text)).toEqual(['first']);
    expect(buffer.handleCaption('s1', 'Ada', 'second')).toBe(true);
  });

  it('hands out copies, so a caller cannot mutate committed state', () => {
    const buffer = new CaptionBuffer();
    buffer.handleCaption('s1', 'Ada', 'original');
    jest.advanceTimersByTime(GRACE);

    buffer.getUtterances()[0].text = 'tampered';
    expect(buffer.getUtterances()[0].text).toBe('original');
  });

  it('clears buffered and committed state on reset', () => {
    const buffer = new CaptionBuffer();
    buffer.handleCaption('s1', 'Ada', 'first');
    jest.advanceTimersByTime(GRACE);
    buffer.handleCaption('s1', 'Ada', 'still open');

    buffer.reset();
    expect(buffer.getUtterances()).toEqual([]);
    expect(buffer.getTranscriptText()).toBe('');
    // The dedupe memory is cleared too, so the same words can be spoken again.
    expect(buffer.handleCaption('s1', 'Ada', 'first')).toBe(true);
  });
});
