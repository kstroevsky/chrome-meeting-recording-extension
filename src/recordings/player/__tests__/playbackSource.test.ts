/** ADR-0006 §14: the page reads OPFS directly; nothing routes bytes through JS. */
import { createFakeOpfs } from '../../../../tests/helpers/fakeOpfs';
import { resolveTrackSource } from '../playbackSource';
import type { PlaybackSource, PlaybackTrack } from '../../../shared/playback';

const track = (sources: PlaybackSource[]): PlaybackTrack => ({
  fileId: 'r1:tab', stream: 'tab', filename: 'tab.webm', mimeType: 'video/webm',
  captureStartOffsetMs: 0, sources,
});

function deps(opfs = createFakeOpfs()) {
  const revoked: string[] = [];
  return {
    opfs,
    revoked,
    resolver: {
      getRoot: async () => opfs.root,
      createObjectURL: (file: Blob) => `blob:${(file as File).size}`,
      revokeObjectURL: (url: string) => { revoked.push(url); },
    },
  };
}

describe('resolveTrackSource', () => {
  it('reads a retained OPFS copy into an object URL', async () => {
    const d = deps();
    d.opfs.seed('library/r1/tab.webm', 4_096);

    const resolved = await resolveTrackSource(track([{ kind: 'opfs', key: 'library/r1/tab.webm' }]), d.resolver);

    expect(resolved).toMatchObject({ kind: 'opfs', url: 'blob:4096' });
    if (resolved.kind === 'opfs') resolved.revoke();
    expect(d.revoked).toEqual(['blob:4096']);
  });

  it('falls through to the next source when the retained file is gone', async () => {
    // A stale location the reconciler has not swept yet must not fail the track.
    const d = deps();
    const resolved = await resolveTrackSource(track([
      { kind: 'opfs', key: 'library/r1/missing.webm' },
      { kind: 'download', downloadId: 7, playableInExtension: false },
    ]), d.resolver);

    expect(resolved).toEqual({ kind: 'external', downloadId: 7 });
  });

  it('reports Drive as not yet wired rather than silently failing', async () => {
    const d = deps();
    const resolved = await resolveTrackSource(track([{ kind: 'drive', fileId: 'd1' }]), d.resolver);
    expect(resolved).toEqual({ kind: 'unsupported', reason: 'drive-not-wired' });
  });

  it('prefers OPFS over Drive when both exist', async () => {
    const d = deps();
    d.opfs.seed('library/r1/tab.webm', 10);
    const resolved = await resolveTrackSource(track([
      { kind: 'opfs', key: 'library/r1/tab.webm' },
      { kind: 'drive', fileId: 'd1' },
    ]), d.resolver);
    expect(resolved.kind).toBe('opfs');
  });

  it('reports a track with no sources as missing', async () => {
    expect(await resolveTrackSource(track([]), deps().resolver)).toEqual({ kind: 'missing' });
  });
});
