import { RecordingNotationService } from '../RecordingNotationService';
import type { RecordingNotationRepositoryPort, RecordingNotationsMutation } from '../RecordingNotationRepository';
import { MAX_NOTATIONS_PER_RECORDING, normalizeRecordingNotations, type RecordingNotation } from '../../shared/notations';

/** In-memory stand-in for the IndexedDB adapter, normalizing on write like the real one. */
function fakeRepository(seed: Record<string, RecordingNotation[]> = {}) {
  const rows = new Map<string, RecordingNotation[]>(Object.entries(seed));
  const port: RecordingNotationRepositoryPort & { rows: Map<string, RecordingNotation[]> } = {
    rows,
    async list(recordingId) {
      return rows.get(recordingId) ?? [];
    },
    async update(recordingId: string, mutate: RecordingNotationsMutation) {
      const next = normalizeRecordingNotations(mutate(rows.get(recordingId) ?? []));
      if (next.length) rows.set(recordingId, next);
      else rows.delete(recordingId);
      return next;
    },
    async remove(recordingId) {
      rows.delete(recordingId);
    },
  };
  return port;
}

const notation = (id: string, tStartMs: number, text = ''): RecordingNotation => ({ id, tStartMs, text });

describe('RecordingNotationService.add', () => {
  it('assigns an id, normalizes text, and stores chronologically', async () => {
    const repository = fakeRepository({ 'recording:1': [notation('notation:late', 9_000, 'later')] });
    const service = new RecordingNotationService(repository);

    const created = await service.add('recording:1', { tStartMs: 1_000, text: '  Intro  ' });

    expect(created).toEqual({ id: expect.stringMatching(/^notation:/), tStartMs: 1_000, text: 'Intro' });
    expect(repository.rows.get('recording:1')).toEqual([created, notation('notation:late', 9_000, 'later')]);
  });

  it('defaults missing text to empty so a moment can be marked and named later', async () => {
    const service = new RecordingNotationService(fakeRepository());
    await expect(service.add('recording:1', { tStartMs: 0 })).resolves.toMatchObject({ text: '' });
  });

  it('keeps a supplied span', async () => {
    const service = new RecordingNotationService(fakeRepository());
    await expect(service.add('recording:1', { tStartMs: 1_000, tEndMs: 2_000 })).resolves.toMatchObject({ tEndMs: 2_000 });
  });

  it('rejects an invalid offset or an out-of-order span', async () => {
    const service = new RecordingNotationService(fakeRepository());
    await expect(service.add('recording:1', { tStartMs: -1 })).rejects.toThrow('non-negative');
    await expect(service.add('recording:1', { tStartMs: Number.NaN })).rejects.toThrow('non-negative');
    await expect(service.add('recording:1', { tStartMs: 5_000, tEndMs: 4_000 })).rejects.toThrow('cannot end before it starts');
  });

  it('enforces the per-recording cap', async () => {
    const full = Array.from({ length: MAX_NOTATIONS_PER_RECORDING }, (_, index) => notation(`notation:${index}`, index));
    const service = new RecordingNotationService(fakeRepository({ 'recording:1': full }));
    await expect(service.add('recording:1', { tStartMs: 1 })).rejects.toThrow('cannot hold more than');
  });
});

describe('RecordingNotationService.update', () => {
  it('patches only the supplied fields and re-sorts', async () => {
    const repository = fakeRepository({
      'recording:1': [notation('notation:a', 1_000, 'first'), notation('notation:b', 2_000, 'second')],
    });
    const service = new RecordingNotationService(repository);

    const result = await service.update('recording:1', 'notation:a', { tStartMs: 5_000 });

    expect(result).toEqual([notation('notation:b', 2_000, 'second'), notation('notation:a', 5_000, 'first')]);
  });

  it('rejects an unknown id without touching the list', async () => {
    const repository = fakeRepository({ 'recording:1': [notation('notation:a', 1_000)] });
    const service = new RecordingNotationService(repository);
    await expect(service.update('recording:1', 'notation:missing', { text: 'x' })).rejects.toThrow('Unknown notation');
    expect(repository.rows.get('recording:1')).toEqual([notation('notation:a', 1_000)]);
  });

  it('rejects a patch that would invert the span', async () => {
    const service = new RecordingNotationService(fakeRepository({
      'recording:1': [{ id: 'notation:a', tStartMs: 1_000, tEndMs: 2_000, text: '' }],
    }));
    await expect(service.update('recording:1', 'notation:a', { tStartMs: 5_000 })).rejects.toThrow('cannot end before it starts');
  });
});

describe('RecordingNotationService.endOpen', () => {
  it('closes an open span', async () => {
    const service = new RecordingNotationService(fakeRepository({ 'recording:1': [notation('notation:a', 1_000)] }));
    await expect(service.endOpen('recording:1', 'notation:a', 4_000)).resolves.toEqual({
      id: 'notation:a', tStartMs: 1_000, tEndMs: 4_000, endedBy: 'user', text: '',
    });
  });

  it('leaves an already-closed span alone so a repeat cannot rewrite it', async () => {
    const repository = fakeRepository({ 'recording:1': [{ id: 'notation:a', tStartMs: 1_000, tEndMs: 2_000, text: '' }] });
    const service = new RecordingNotationService(repository);

    await expect(service.endOpen('recording:1', 'notation:a', 9_000)).resolves.toMatchObject({ tEndMs: 2_000 });
    expect(repository.rows.get('recording:1')).toEqual([{ id: 'notation:a', tStartMs: 1_000, tEndMs: 2_000, text: '' }]);
  });

  it('rejects an unknown id or an end before the start', async () => {
    const service = new RecordingNotationService(fakeRepository({ 'recording:1': [notation('notation:a', 5_000)] }));
    await expect(service.endOpen('recording:1', 'notation:missing', 9_000)).rejects.toThrow('Unknown notation');
    await expect(service.endOpen('recording:1', 'notation:a', 4_000)).rejects.toThrow('cannot end before it starts');
  });
});

describe('RecordingNotationService.closeOpenSpans', () => {
  it('seals open spans at the run\u2019s last recorded position and marks them auto-closed', async () => {
    const repository = fakeRepository({
      'recording:1': [
        { id: 'notation:open', tStartMs: 1_000, text: 'still going' },
        { id: 'notation:closed', tStartMs: 2_000, tEndMs: 3_000, endedBy: 'user', text: 'done' },
      ],
    });
    const service = new RecordingNotationService(repository);

    const result = await service.closeOpenSpans('recording:1', 9_000);

    expect(result).toEqual([
      { id: 'notation:open', tStartMs: 1_000, tEndMs: 9_000, endedBy: 'auto', text: 'still going' },
      { id: 'notation:closed', tStartMs: 2_000, tEndMs: 3_000, endedBy: 'user', text: 'done' },
    ]);
  });

  it('never discards a note the run outlived', async () => {
    const repository = fakeRepository({ 'recording:1': [{ id: 'notation:open', tStartMs: 500, text: 'kept' }] });
    const service = new RecordingNotationService(repository);

    await service.closeOpenSpans('recording:1', 4_000);

    expect(repository.rows.get('recording:1')).toHaveLength(1);
  });

  it('clamps rather than rejects when the run ends inside the same instant as the mark', async () => {
    const repository = fakeRepository({ 'recording:1': [{ id: 'notation:open', tStartMs: 5_000, text: '' }] });
    const service = new RecordingNotationService(repository);

    await service.closeOpenSpans('recording:1', 4_999);

    expect(repository.rows.get('recording:1')?.[0]).toMatchObject({ tStartMs: 5_000, tEndMs: 5_000, endedBy: 'auto' });
  });

  it('is idempotent \u2014 a second call leaves the sealed spans alone', async () => {
    const repository = fakeRepository({ 'recording:1': [{ id: 'notation:open', tStartMs: 1_000, text: '' }] });
    const service = new RecordingNotationService(repository);

    await service.closeOpenSpans('recording:1', 6_000);
    await service.closeOpenSpans('recording:1', 99_000);

    expect(repository.rows.get('recording:1')?.[0]).toMatchObject({ tEndMs: 6_000, endedBy: 'auto' });
  });

  it('does nothing for a recording with no open spans', async () => {
    const repository = fakeRepository({});
    const service = new RecordingNotationService(repository);

    await expect(service.closeOpenSpans('recording:none', 1_000)).resolves.toEqual([]);
  });
});

describe('RecordingNotationService removal', () => {
  it('removes one notation and rejects an unknown id', async () => {
    const repository = fakeRepository({
      'recording:1': [notation('notation:a', 1_000), notation('notation:b', 2_000)],
    });
    const service = new RecordingNotationService(repository);

    await expect(service.remove('recording:1', 'notation:a')).resolves.toEqual([notation('notation:b', 2_000)]);
    await expect(service.remove('recording:1', 'notation:a')).rejects.toThrow('Unknown notation');
  });

  it('removeAll drops the whole recording', async () => {
    const repository = fakeRepository({ 'recording:1': [notation('notation:a', 1_000)] });
    const service = new RecordingNotationService(repository);

    await service.removeAll('recording:1');
    expect(repository.rows.has('recording:1')).toBe(false);
  });
});
