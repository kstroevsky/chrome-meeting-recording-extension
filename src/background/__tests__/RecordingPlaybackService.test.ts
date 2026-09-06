/** ADR-0006 §11: the manifest carries capabilities, never bytes. */
import { RecordingPlaybackService } from '../RecordingPlaybackService';
import { isPlayable, masterTrack } from '../../shared/playback';
import { historyFile } from '../../../tests/helpers/recordingHistoryFixtures';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';

const entry = (over: Partial<RecordingHistoryEntry> = {}): RecordingHistoryEntry => ({
  id: 'r1',
  name: 'Weekly sync',
  createdAt: 1,
  durationMs: 1_360_000,
  storageMode: 'drive',
  status: 'complete',
  files: [],
  ...over,
});

const file = (id: string, stream: 'tab' | 'mic' | 'self-video', over: Record<string, unknown> = {}) =>
  historyFile({
    id, stream, filename: `${stream}.webm`, destination: 'drive', status: 'available', ...over,
  } as never);

const make = (e?: RecordingHistoryEntry, notations: unknown[] = []) => new RecordingPlaybackService({
  getEntry: jest.fn(async () => e),
  listNotations: jest.fn(async () => notations as never),
});

describe('RecordingPlaybackService.getManifest', () => {
  it('builds a manifest with tracks in tab, mic, self-video order', async () => {
    const service = make(entry({
      files: [file('r1:mic', 'mic'), file('r1:self', 'self-video'), file('r1:tab', 'tab')],
    }));

    const manifest = (await service.getManifest('r1'))!;
    expect(manifest.tracks.map((t) => t.stream)).toEqual(['tab', 'mic', 'self-video']);
    expect(manifest).toMatchObject({ recordingId: 'r1', title: 'Weekly sync', durationMs: 1_360_000 });
  });

  it('orders sources OPFS, then Drive, then the un-streamable Downloads copy', async () => {
    const service = make(entry({
      files: [file('r1:tab', 'tab', {
        locations: [
          { kind: 'download', downloadId: 7 },
          { kind: 'drive', fileId: 'd1' },
          { kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 5 },
        ],
      })],
    }));

    expect((await service.getManifest('r1'))!.tracks[0].sources).toEqual([
      { kind: 'opfs', key: 'library/r1/tab.webm' },
      { kind: 'drive', fileId: 'd1' },
      { kind: 'download', downloadId: 7, playableInExtension: false },
    ]);
  });

  it('keeps the notes sidecar out of the tracks', async () => {
    const service = make(entry({
      files: [
        file('r1:tab', 'tab'),
        historyFile({ id: 'r1:notes', stream: 'tab', kind: 'notes', filename: 'notes.vtt', destination: 'drive', status: 'available' }),
      ],
    }));

    const manifest = (await service.getManifest('r1'))!;
    expect(manifest.tracks.map((t) => t.fileId)).toEqual(['r1:tab']);
  });

  it('carries notations through unchanged — the player reuses the aggregate', async () => {
    const notes = [{ id: 'n1', tStartMs: 1_000, tEndMs: 4_000, text: 'Decision' }];
    const service = make(entry({ files: [file('r1:tab', 'tab')] }), notes);

    expect((await service.getManifest('r1'))!.notations).toEqual(notes);
  });

  it('defaults a track offset to 0 and preserves a measured one', async () => {
    const service = make(entry({
      files: [file('r1:tab', 'tab'), file('r1:mic', 'mic', { captureStartOffsetMs: -120 })],
    }));

    const manifest = (await service.getManifest('r1'))!;
    expect(manifest.tracks.map((t) => t.captureStartOffsetMs)).toEqual([0, -120]);
  });

  it('returns nothing for a missing or tombstoned recording', async () => {
    await expect(make(undefined).getManifest('r1')).resolves.toBeUndefined();
    await expect(make(entry({ deletedAt: 9 })).getManifest('r1')).resolves.toBeUndefined();
  });
});

describe('manifest helpers', () => {
  const manifestWith = (tracks: unknown[]) => ({ recordingId: 'r1', title: 'x', notations: [], tracks } as never);

  it('treats a Downloads-only recording as unplayable in the extension', async () => {
    const service = make(entry({
      files: [file('r1:tab', 'tab', { locations: [{ kind: 'download', downloadId: 7 }] })],
    }));

    const manifest = (await service.getManifest('r1'))!;
    // The legacy case: the extension no longer owns the bytes, only a download id.
    expect(isPlayable(manifest)).toBe(false);
    expect(manifest.tracks[0].sources).toEqual([{ kind: 'download', downloadId: 7, playableInExtension: false }]);
  });

  it('picks the tab track as master, and falls back to any streamable track', () => {
    expect(masterTrack(manifestWith([
      { stream: 'mic', sources: [{ kind: 'opfs', key: 'a' }] },
      { stream: 'tab', sources: [{ kind: 'drive', fileId: 'd' }] },
    ]))?.stream).toBe('tab');

    // A mic-only recording still needs a clock.
    expect(masterTrack(manifestWith([
      { stream: 'mic', sources: [{ kind: 'opfs', key: 'a' }] },
    ]))?.stream).toBe('mic');

    expect(masterTrack(manifestWith([
      { stream: 'mic', sources: [{ kind: 'download', downloadId: 1, playableInExtension: false }] },
    ]))).toBeUndefined();

    // A tab track with only a Downloads copy is not a master: the readable mic
    // track is, or playback fails for a recording that was perfectly reachable.
    expect(masterTrack(manifestWith([
      { stream: 'tab', sources: [{ kind: 'download', downloadId: 1, playableInExtension: false }] },
      { stream: 'mic', sources: [{ kind: 'opfs', key: 'a' }] },
    ]))?.stream).toBe('mic');
  });
});
