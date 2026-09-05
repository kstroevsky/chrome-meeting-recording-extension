/**
 * ADR-0006 step 11: what the player does when a recording cannot be reached.
 * Every one of these ends in an honest message rather than a silent dead player.
 */
import { PlayerController, type PlayerControllerDeps } from '../PlayerController';
import { createFakeOpfs } from '../../../../tests/helpers/fakeOpfs';
import type { PlaybackManifest, PlaybackSource } from '../../../shared/playback';

const manifest = (sources: PlaybackSource[], extra: Partial<PlaybackManifest> = {}): PlaybackManifest => ({
  recordingId: 'r1',
  title: 'Weekly sync',
  createdAt: 0,
  transcriptStatus: 'none',
  notations: [],
  tracks: [{
    fileId: 'r1:tab', stream: 'tab', filename: 'tab.webm', mimeType: 'video/webm',
    timelineOffsetMs: 0, sources,
  }],
  ...extra,
});

function make(over: Partial<PlayerControllerDeps> = {}) {
  const opfs = createFakeOpfs();
  const prepareDriveSource = jest.fn(async () => 'https://www.googleapis.com/drive/v3/files/d1?alt=media');
  const controller = new PlayerController({
    getManifest: jest.fn(async () => manifest([])),
    prepareDriveSource,
    warn: jest.fn(),
    resolver: {
      getRoot: async () => opfs.root,
      createObjectURL: (file: Blob) => `blob:${(file as File).size}`,
      revokeObjectURL: () => {},
    },
    ...over,
  });
  document.body.append(controller.element);
  return { controller, opfs, prepareDriveSource };
}

const statusText = (controller: PlayerController) =>
  controller.element.querySelector('.player__status')?.textContent ?? '';
const videoSrc = (controller: PlayerController) =>
  (controller.element.querySelector('.player__video') as HTMLVideoElement).getAttribute('src');

afterEach(() => { document.body.replaceChildren(); });

describe('unreachable recordings', () => {
  it('says so when the recording is gone entirely', async () => {
    const { controller } = make({ getManifest: jest.fn(async () => undefined) });
    await controller.open('r1');
    expect(statusText(controller)).toMatch(/no longer available/i);
  });

  it('points at the downloaded file for a legacy local recording', async () => {
    // Only a Downloads copy remains; chrome.downloads exposes no bytes to us.
    const { controller } = make({
      getManifest: jest.fn(async () => manifest([{ kind: 'download', downloadId: 7, playableInExtension: false }])),
    });
    await controller.open('r1');
    expect(statusText(controller)).toMatch(/saved before in-extension playback/i);
    expect(videoSrc(controller)).toBeNull();
  });

  it('says the copies are gone when a track has no sources at all', async () => {
    const { controller } = make({ getManifest: jest.fn(async () => manifest([])) });
    await controller.open('r1');
    expect(statusText(controller)).toMatch(/no playable copy/i);
  });

  it('falls through to Drive when the retained file has vanished', async () => {
    // A stale OPFS location the reconciler has not swept yet.
    const { controller, prepareDriveSource } = make({
      getManifest: jest.fn(async () => manifest([
        { kind: 'opfs', key: 'library/r1/gone.webm' },
        { kind: 'drive', fileId: 'd1' },
      ])),
    });
    await controller.open('r1');
    expect(prepareDriveSource).toHaveBeenCalled();
    expect(videoSrc(controller)).toMatch(/^https:\/\/www\.googleapis\.com\//);
  });

  it('reports a Drive file that can no longer be prepared', async () => {
    // Deleted from Drive, or the token was refused: same outcome for the user.
    const { controller } = make({
      getManifest: jest.fn(async () => manifest([{ kind: 'drive', fileId: 'd1' }])),
      prepareDriveSource: jest.fn(async () => undefined),
    });
    await controller.open('r1');
    expect(statusText(controller)).toMatch(/could not open this recording from google drive/i);
  });

  it('survives the prepare call throwing rather than leaving a blank dialog', async () => {
    const warn = jest.fn();
    const { controller } = make({
      getManifest: jest.fn(async () => manifest([{ kind: 'drive', fileId: 'd1' }])),
      prepareDriveSource: jest.fn(async () => { throw new Error('offline'); }),
      warn,
    });
    await controller.open('r1');
    expect(statusText(controller)).toMatch(/could not open/i);
    expect(warn).toHaveBeenCalled();
  });
});

describe('playing what can be reached', () => {
  it('prefers the retained copy over Drive', async () => {
    const { controller, opfs, prepareDriveSource } = make({
      getManifest: jest.fn(async () => manifest([
        { kind: 'opfs', key: 'library/r1/tab.webm' },
        { kind: 'drive', fileId: 'd1' },
      ])),
    });
    opfs.seed('library/r1/tab.webm', 2_048);
    await controller.open('r1');
    expect(videoSrc(controller)).toBe('blob:2048');
    expect(prepareDriveSource).not.toHaveBeenCalled();
  });

  it('clears the failure message once a source is found', async () => {
    const { controller, opfs } = make({
      getManifest: jest.fn(async () => manifest([{ kind: 'opfs', key: 'library/r1/tab.webm' }])),
    });
    opfs.seed('library/r1/tab.webm', 512);
    await controller.open('r1');
    expect(controller.element.querySelector('.player__status')).toHaveProperty('hidden', true);
  });
});

describe('closing', () => {
  it('revokes the object URL, because an unrevoked one pins the OPFS file', async () => {
    const revoked: string[] = [];
    const opfs = createFakeOpfs();
    opfs.seed('library/r1/tab.webm', 64);
    const controller = new PlayerController({
      getManifest: async () => manifest([{ kind: 'opfs', key: 'library/r1/tab.webm' }]),
      prepareDriveSource: async () => undefined,
      resolver: {
        getRoot: async () => opfs.root,
        createObjectURL: () => 'blob:pinned',
        revokeObjectURL: (url: string) => { revoked.push(url); },
      },
    });
    document.body.append(controller.element);

    await controller.open('r1');
    controller.close();

    expect(revoked).toEqual(['blob:pinned']);
    expect(document.querySelector('.player')).toBeNull();
  });
});
