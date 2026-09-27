import { RecordingTranscriptService } from '../RecordingTranscriptService';
import type { RecordingTranscriptMutation, RecordingTranscriptRepositoryPort } from '../RecordingTranscriptRepository';
import {
  MAX_TRANSCRIPT_TEXT_LENGTH,
  MAX_TRANSCRIPT_SEGMENTS,
  normalizeTranscript,
  type Transcript,
  type TranscriptSegment,
} from '../../../../shared/transcript';
import {
  TRANSCRIPT_CANONICALIZATION_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
  type TranscriptSnapshot,
} from '../../../../shared/transcriptIdentity';

/** In-memory stand-in for the IndexedDB adapter, normalizing on write like the real one. */
function fakeRepository(seed: Record<string, Transcript> = {}) {
  const rows = new Map<string, TranscriptSnapshot>(Object.entries(seed).map(([id, transcript]) => [id, {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
    generation: `generation:${id}:1`,
    revision: 1,
    contentHash: `hash:${id}:1`,
    committedAt: 1,
    transcript,
  }]));
  const port: RecordingTranscriptRepositoryPort & { rows: Map<string, TranscriptSnapshot> } = {
    rows,
    async get(recordingId) {
      return rows.get(recordingId);
    },
    async update(recordingId: string, mutate: RecordingTranscriptMutation) {
      const current = rows.get(recordingId);
      const raw = mutate(current?.transcript);
      if (raw === current?.transcript) return current;
      const next = normalizeTranscript(raw);
      if (!next?.segments.length) {
        rows.delete(recordingId);
        return undefined;
      }
      const revision = (current?.revision ?? 0) + 1;
      const snapshot: TranscriptSnapshot = {
        schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
        canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
        generation: `generation:${recordingId}:${revision}`,
        revision,
        contentHash: `hash:${recordingId}:${revision}`,
        committedAt: revision,
        transcript: next,
      };
      rows.set(recordingId, snapshot);
      return snapshot;
    },
    async cacheContentHash(recordingId, generation, revision, contentHash) {
      const current = rows.get(recordingId);
      if (current?.generation === generation && current.revision === revision) {
        rows.set(recordingId, { ...current, contentHash });
      }
    },
    async listRecordingIds(limit, after) {
      const ids = [...rows.keys()].sort().filter((id) => !after || id > after);
      const recordingIds = ids.slice(0, limit);
      return {
        recordingIds,
        ...(ids.length > limit && recordingIds.length
          ? { nextCursor: recordingIds[recordingIds.length - 1] }
          : {}),
      };
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

  it('replaces a transcript as a new revision and announces the commit', async () => {
    const repository = fakeRepository();
    const committed: TranscriptSnapshot[] = [];
    const service = new RecordingTranscriptService(repository, (_id, snapshot) => {
      committed.push(snapshot);
    });
    await service.append('rec:1', 'meet-captions', [segment(0, 'caption')]);

    const replaced = await service.replace('rec:1', {
      source: 'stt',
      segments: [segment(0, 'speech recognition')],
    });

    expect(replaced.revision).toBe(2);
    expect(replaced.transcript.source).toBe('stt');
    expect(committed).toEqual([replaced]);
  });

  it('preserves the previous snapshot when replacement validation rejects', async () => {
    const repository = fakeRepository();
    const service = new RecordingTranscriptService(repository);
    await service.replace('rec:1', { source: 'meet-captions', segments: [segment(0, 'kept')] });
    const before = await service.getSnapshot('rec:1');

    const invalid: Transcript[] = [
      { source: 'stt', segments: [] },
      { source: 'stt', segments: [{ tStartMs: -1, tEndMs: 1, text: 'bad time' }] },
      { source: 'stt', segments: [{ tStartMs: 0, tEndMs: 1, text: 'x'.repeat(MAX_TRANSCRIPT_TEXT_LENGTH + 1) }] },
      { source: 'guessed' as Transcript['source'], segments: [segment(0, 'bad source')] },
    ];

    for (const replacement of invalid) {
      await expect(service.replace('rec:1', replacement)).rejects.toThrow();
      await expect(service.getSnapshot('rec:1')).resolves.toEqual(before);
    }
  });

  it('commits the current revision without changing its identity', async () => {
    const repository = fakeRepository();
    const committed: TranscriptSnapshot[] = [];
    const service = new RecordingTranscriptService(repository, (_id, snapshot) => {
      committed.push(snapshot);
    });
    await service.append('rec:1', 'meet-captions', [segment(0, 'caption')]);
    const before = await service.getSnapshot('rec:1');

    const committedSnapshot = await service.commit('rec:1');

    expect(committedSnapshot).toEqual(before);
    expect(committed).toEqual([before]);
  });

  it('tells integrations about every change to the stored transcript, and only those', async () => {
    const changed: string[] = [];
    const service = new RecordingTranscriptService(fakeRepository(), undefined, (id) => { changed.push(id); });
    await service.append('rec:1', 'meet-captions', [segment(0, 'caption')]);
    await service.append('rec:1', 'meet-captions', [segment(0, 'caption')]); // a redelivery stores nothing
    await service.replace('rec:1', { source: 'stt', segments: [segment(0, 'speech recognition')] });
    await service.commit('rec:1'); // announces completeness, changes nothing
    expect(changed).toEqual(['rec:1', 'rec:1']);
  });

  it('drops a recording transcript entirely', async () => {
    const service = new RecordingTranscriptService(fakeRepository());
    await service.append('rec:1', 'meet-captions', [segment(0, 'first')]);
    await service.removeAll('rec:1');

    await expect(service.get('rec:1')).resolves.toBeUndefined();
    await expect(service.status('rec:1')).resolves.toBe('none');
  });
});
