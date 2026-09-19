import { RecordingTranscriptService } from '../RecordingTranscriptService';
import type { RecordingTranscriptMutation, RecordingTranscriptRepositoryPort } from '../RecordingTranscriptRepository';
import {
  MAX_TRANSCRIPT_SEGMENTS,
  normalizeTranscript,
  type Transcript,
  type TranscriptSegment,
} from '../../shared/transcript';

/** In-memory stand-in for the IndexedDB adapter, normalizing on write like the real one. */
function fakeRepository(seed: Record<string, Transcript> = {}) {
  const rows = new Map<string, Transcript>(Object.entries(seed));
  const port: RecordingTranscriptRepositoryPort & { rows: Map<string, Transcript> } = {
    rows,
    async get(recordingId) {
      return rows.get(recordingId);
    },
    async update(recordingId: string, mutate: RecordingTranscriptMutation) {
      const next = normalizeTranscript(mutate(rows.get(recordingId)));
      if (next && next.segments.length) rows.set(recordingId, next);
      else rows.delete(recordingId);
      return next;
    },
    async remove(recordingId) {
      rows.delete(recordingId);
    },
  };
  return port;
}

const segment = (tStartMs: number, text: string, speaker = 'Ada'): TranscriptSegment =>
  ({ tStartMs, tEndMs: tStartMs + 500, speaker, text });

describe('RecordingTranscriptService', () => {
  it('creates a transcript on first append and grows it after', async () => {
    const repository = fakeRepository();
    const service = new RecordingTranscriptService(repository);

    await expect(service.append('rec:1', 'meet-captions', [segment(0, 'first')])).resolves.toBe(1);
    await expect(service.append('rec:1', 'meet-captions', [segment(1_000, 'second')])).resolves.toBe(1);

    await expect(service.get('rec:1')).resolves.toEqual({
      source: 'meet-captions',
      segments: [segment(0, 'first'), segment(1_000, 'second')],
    });
  });

  it('keeps the transcript chronological regardless of arrival order', async () => {
    const service = new RecordingTranscriptService(fakeRepository());
    await service.append('rec:1', 'meet-captions', [segment(2_000, 'late')]);
    await service.append('rec:1', 'meet-captions', [segment(0, 'early')]);

    const stored = await service.get('rec:1');
    expect(stored?.segments.map((s) => s.text)).toEqual(['early', 'late']);
  });

  it('drops a redelivered utterance rather than duplicating it', async () => {
    const service = new RecordingTranscriptService(fakeRepository());
    await service.append('rec:1', 'meet-captions', [segment(0, 'first')]);

    // The push channel is fire-and-forget, so the same commit can arrive twice.
    await expect(service.append('rec:1', 'meet-captions', [segment(0, 'first')])).resolves.toBe(0);
    await expect(service.append('rec:1', 'meet-captions', [segment(0, 'first'), segment(1_000, 'new')]))
      .resolves.toBe(1);

    const stored = await service.get('rec:1');
    expect(stored?.segments.map((s) => s.text)).toEqual(['first', 'new']);
  });

  it('deduplicates within a single batch too', async () => {
    const service = new RecordingTranscriptService(fakeRepository());
    await expect(service.append('rec:1', 'meet-captions', [segment(0, 'x'), segment(0, 'x')])).resolves.toBe(1);
  });

  it('treats the same words at a different time as a different utterance', async () => {
    const service = new RecordingTranscriptService(fakeRepository());
    await service.append('rec:1', 'meet-captions', [segment(0, 'right')]);
    await expect(service.append('rec:1', 'meet-captions', [segment(9_000, 'right')])).resolves.toBe(1);
    await expect(service.get('rec:1')).resolves.toHaveProperty('segments.length', 2);
  });

  it('does nothing for an empty append', async () => {
    const repository = fakeRepository();
    const service = new RecordingTranscriptService(repository);
    await expect(service.append('rec:1', 'meet-captions', [])).resolves.toBe(0);
    expect(repository.rows.has('rec:1')).toBe(false);
  });

  it('refuses to mix sources rather than guessing a selection policy', async () => {
    const service = new RecordingTranscriptService(fakeRepository());
    await service.append('rec:1', 'meet-captions', [segment(0, 'from captions')]);

    await expect(service.append('rec:1', 'stt', [segment(1_000, 'from audio')]))
      .rejects.toThrow(/refusing to append stt/);
    // The existing transcript is untouched.
    await expect(service.get('rec:1')).resolves.toHaveProperty('segments.length', 1);
  });

  it('refuses an append that would exceed the per-recording bound', async () => {
    const service = new RecordingTranscriptService(fakeRepository());
    const many = Array.from({ length: MAX_TRANSCRIPT_SEGMENTS }, (_, i) => segment(i, `line ${i}`));
    await expect(service.append('rec:1', 'meet-captions', many)).resolves.toBe(MAX_TRANSCRIPT_SEGMENTS);

    await expect(service.append('rec:1', 'meet-captions', [segment(9_999_999, 'one too many')]))
      .rejects.toThrow(/cannot hold more than/);
  });

  it('reports the rail state from whether words exist', async () => {
    const service = new RecordingTranscriptService(fakeRepository());
    await expect(service.status('rec:1')).resolves.toBe('none');

    await service.append('rec:1', 'meet-captions', [segment(0, 'first')]);
    await expect(service.status('rec:1')).resolves.toBe('ready');
  });

  it('drops a recording transcript entirely', async () => {
    const service = new RecordingTranscriptService(fakeRepository());
    await service.append('rec:1', 'meet-captions', [segment(0, 'first')]);
    await service.removeAll('rec:1');

    await expect(service.get('rec:1')).resolves.toBeUndefined();
    await expect(service.status('rec:1')).resolves.toBe('none');
  });
});
