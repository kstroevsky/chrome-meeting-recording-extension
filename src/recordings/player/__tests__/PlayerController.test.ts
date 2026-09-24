/**
 * ADR-0006 step 11: what the player does when a recording cannot be reached.
 * Every one of these ends in an honest message rather than a silent dead player.
 */
import { PlayerController, type PlayerControllerDeps } from '../PlayerController';
import { createPlaybackTrackResolver, type PlaybackUrlDeps } from '../playbackSource';
import type { PlayerStatus } from '../PlayerView';
import { createFakeOpfs } from '../../../../tests/helpers/fakeOpfs';
import type { PlaybackManifest, PlaybackSource, PlaybackTrack } from '../../../shared/playback';

const manifest = (sources: PlaybackSource[], extra: Partial<PlaybackManifest> = {}): PlaybackManifest => ({
  recordingId: 'r1',
  title: 'Weekly sync',
  createdAt: 0,
  transcriptStatus: 'none',
  notations: [],
  topics: [],
  tracks: [{
    fileId: 'r1:tab', stream: 'tab', filename: 'tab.webm', mimeType: 'video/webm',
    captureStartOffsetMs: 0, sources,
  }],
  ...extra,
});

type PlayerTestOverrides = Omit<Partial<PlayerControllerDeps>, 'resolveTrack'>
  & Partial<PlaybackUrlDeps>
  & { resolveTrack?: PlayerControllerDeps['resolveTrack'] };

const unavailableStatus = (track: PlaybackTrack): PlayerStatus | undefined =>
  track.sources.some((source) => source.kind === 'drive')
    ? {
        title: 'Could not open this recording from Google Drive.',
        body: 'It was deleted or moved, or Drive could not be reached. Notes and transcript are kept by the extension and are still available.',
        actions: ['folder', 'remove'],
      }
    : undefined;

function make(over: PlayerTestOverrides = {}) {
  const opfs = createFakeOpfs();
  const defaultPrepareDriveSource = jest.fn(async () => 'https://www.googleapis.com/drive/v3/files/d1?alt=media');
  const {
    prepareDriveSource = defaultPrepareDriveSource,
    resolver = {
      getRoot: async () => opfs.root,
      createObjectURL: (file: Blob) => `blob:${(file as File).size}`,
      revokeObjectURL: () => {},
    },
    resolveTrack,
    warn = jest.fn(),
    ...controllerOverrides
  } = over;
  const controller = new PlayerController({
    getManifest: jest.fn(async () => manifest([])),
    resolveTrack: resolveTrack ?? createPlaybackTrackResolver({ prepareDriveSource, resolver, warn }),
    unavailableStatus,
    warn,
    ...controllerOverrides,
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
      resolveTrack: createPlaybackTrackResolver({ resolver: {
        getRoot: async () => opfs.root,
        createObjectURL: () => 'blob:pinned',
        revokeObjectURL: (url: string) => { revoked.push(url); },
      } }),
    });
    document.body.append(controller.element);

    await controller.open('r1');
    controller.close();

    expect(revoked).toEqual(['blob:pinned']);
    expect(document.querySelector('.player')).toBeNull();
  });
});

describe('autoplay', () => {
  it('starts playing as soon as a source attaches', async () => {
    const opfs = createFakeOpfs();
    opfs.seed('library/r1/tab.webm', 128);
    const controller = new PlayerController({
      getManifest: async () => manifest([{ kind: 'opfs', key: 'library/r1/tab.webm' }]),
      resolveTrack: createPlaybackTrackResolver({ resolver: {
        getRoot: async () => opfs.root,
        createObjectURL: () => 'blob:x',
        revokeObjectURL: () => {},
      } }),
    });
    document.body.append(controller.element);
    const video = controller.element.querySelector('.player__video') as HTMLVideoElement;
    const play = jest.fn(async () => {});
    Object.defineProperty(video, 'play', { value: play });

    await controller.open('r1');
    expect(play).toHaveBeenCalled();
  });

  it('does not try to play a recording with nothing attached', async () => {
    const controller = new PlayerController({
      getManifest: async () => manifest([]),
      resolveTrack: async () => undefined,
    });
    document.body.append(controller.element);
    const video = controller.element.querySelector('.player__video') as HTMLVideoElement;
    const play = jest.fn(async () => {});
    Object.defineProperty(video, 'play', { value: play });

    await controller.open('r1');
    expect(play).not.toHaveBeenCalled();
  });
});


describe('transcript rail (f10)', () => {
  const flushAll = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const transcript = {
    source: 'meet-captions' as const,
    segments: [
      { tStartMs: 1_000, tEndMs: 2_000, speaker: 'Alex', text: 'Before the note.' },
      { tStartMs: 10_000, tEndMs: 12_000, speaker: 'Maria', text: 'Inside the note.' },
    ],
  };
  const noted = { notations: [{ id: 'n1', tStartMs: 9_000, tEndMs: 20_000, endedBy: 'user' as const, text: 'Pricing objection' }] };

  it('is absent, header toggle and all, when the recording has no transcript (f11/f12)', async () => {
    const getTranscript = jest.fn();
    const { controller } = make({ getManifest: jest.fn(async () => manifest([], noted)), getTranscript });
    await controller.open('r1');
    await flushAll();
    expect(getTranscript).not.toHaveBeenCalled();
    expect(controller.element.querySelector<HTMLElement>('.player__rail')!.hidden).toBe(true);
    expect(controller.element.querySelector<HTMLElement>('.player__rail-toggle')!.hidden).toBe(true);
  });

  it('lists the transcript beside the picture, headed by the notes its lines fall in', async () => {
    const { controller } = make({
      getManifest: jest.fn(async () => manifest([], { ...noted, transcriptStatus: 'ready' })),
      getTranscript: jest.fn(async () => transcript),
    });
    await controller.open('r1');
    await flushAll();
    const rail = controller.element.querySelector<HTMLElement>('.player__rail')!;
    expect(rail.hidden).toBe(false);
    expect(rail.querySelector('.player__rail-count')?.textContent).toBe('1 NOTE');
    expect(rail.querySelectorAll('.player__rail-line')).toHaveLength(2);
    expect(Array.from(rail.querySelectorAll('.player__rail-heading'), (h) => h.textContent)).toEqual(['Pricing objection']);

    const toggle = controller.element.querySelector<HTMLButtonElement>('.player__rail-toggle')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(rail.hidden).toBe(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the player working, silently, when the transcript cannot be read', async () => {
    const { controller } = make({
      getManifest: jest.fn(async () => manifest([], { transcriptStatus: 'ready' })),
      getTranscript: jest.fn(async () => { throw new Error('storage unavailable'); }),
    });
    await controller.open('r1');
    await flushAll();
    expect(controller.element.querySelector<HTMLElement>('.player__rail')!.hidden).toBe(true);
    // The status speaks for the missing video only, never for the transcript.
    expect(statusText(controller)).not.toMatch(/transcript cannot|could not read/i);
  });
});

describe('the rail as an index (f18, f20)', () => {
  const flushAll = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const note = (id: string, startS: number, text: string) =>
    ({ id, tStartMs: startS * 1000, tEndMs: startS * 1000 + 5_000, endedBy: 'user' as const, text });
  const lineAt = (startS: number, text: string) => ({ tStartMs: startS * 1000, tEndMs: startS * 1000 + 2_000, speaker: 'Alex', text });

  async function openWith(notations: ReturnType<typeof note>[], over: Partial<PlayerControllerDeps> = {}) {
    // One line per note, and a line of its own when there are no notes to hang them on.
    const segments = notations.length
      ? notations.map((n) => lineAt(n.tStartMs / 1000 + 1, `Said during ${n.text || 'nothing'}`))
      : [lineAt(30, 'Said with nothing noted')];
    const { controller } = make({
      getManifest: jest.fn(async () => manifest([], { transcriptStatus: 'ready', durationMs: 3_600_000, notations })),
      getTranscript: jest.fn(async () => ({ source: 'meet-captions' as const, segments })),
      ...over,
    });
    await controller.open('r1');
    await flushAll();
    return controller;
  }
  const headingNames = (controller: PlayerController) =>
    Array.from(controller.element.querySelectorAll('.player__rail-heading-name'), (name) => name.textContent);
  const press = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('renames a note from its heading, and its mark follows (f18)', async () => {
    const renameNotation = jest.fn(async () => []);
    const controller = await openWith([note('n1', 100, 'Pricing objection')], { renameNotation });

    controller.element.querySelector<HTMLElement>('.player__rail-heading-name')!.click();
    const input = controller.element.querySelector<HTMLInputElement>('.player__rail-rename-input')!;
    expect(input.value).toBe('Pricing objection');
    input.value = 'Price pushback';
    press(input, 'Enter');
    await flushAll();

    expect(renameNotation).toHaveBeenCalledWith('r1', 'n1', 'Price pushback');
    expect(headingNames(controller)).toEqual(['Price pushback']);
    expect(controller.element.querySelector<HTMLElement>('.player__mark')!.title).toBe('Price pushback');
  });

  it('puts the old name back on Escape, without closing the player', async () => {
    const renameNotation = jest.fn(async () => []);
    const controller = await openWith([note('n1', 100, 'Pricing objection')], { renameNotation });

    controller.element.querySelector<HTMLButtonElement>('.player__rail-rename')!.click();
    const input = controller.element.querySelector<HTMLInputElement>('.player__rail-rename-input')!;
    input.value = 'Something else';
    press(input, 'Escape');
    await flushAll();

    expect(renameNotation).not.toHaveBeenCalled();
    expect(headingNames(controller)).toEqual(['Pricing objection']);
    expect(controller.element.isConnected).toBe(true);
  });

  it('puts the old name back when the write fails', async () => {
    const renameNotation = jest.fn(async () => { throw new Error('storage unavailable'); });
    const controller = await openWith([note('n1', 100, 'Pricing objection')], { renameNotation });

    controller.element.querySelector<HTMLElement>('.player__rail-heading-name')!.click();
    const input = controller.element.querySelector<HTMLInputElement>('.player__rail-rename-input')!;
    input.value = 'Price pushback';
    press(input, 'Enter');
    await flushAll();

    expect(headingNames(controller)).toEqual(['Pricing objection']);
  });

  it('renames the note under the playhead on R', async () => {
    const controller = await openWith([note('n1', 100, 'First'), note('n2', 200, 'Second')], { renameNotation: jest.fn(async () => []) });
    controller.element.querySelector<HTMLVideoElement>('.player__video')!.currentTime = 202;

    press(document.body, 'r');

    const editing = controller.element.querySelector<HTMLElement>('.player__rail-heading--editing')!;
    expect(editing.dataset.noteId).toBe('n2');
  });

  it('offers no rename where the page cannot write one: the heading only plays', async () => {
    const controller = await openWith([note('n1', 100, 'Pricing objection')]);
    expect(controller.element.querySelector('.player__rail-rename')).toBeNull();
    controller.element.querySelector<HTMLElement>('.player__rail-heading-name')!.click();
    expect(controller.element.querySelector('.player__rail-rename-input')).toBeNull();
  });

  it('says NO NOTES when a transcript carries none, and T shows or hides the rail (f14, f19)', async () => {
    const controller = await openWith([]);
    expect(controller.element.querySelector('.player__rail-count')?.textContent).toBe('NO NOTES');

    const rail = controller.element.querySelector<HTMLElement>('.player__rail')!;
    expect(rail.hidden).toBe(false);
    press(document.body, 't');
    expect(rail.hidden).toBe(true);
    press(document.body, 't');
    expect(rail.hidden).toBe(false);
  });

  it('keeps a short rail plain, with no search and no heading times (f10)', async () => {
    const controller = await openWith([note('n1', 100, 'One'), note('n2', 200, 'Two')]);
    expect(controller.element.querySelector<HTMLElement>('.player__rail-search')!.hidden).toBe(true);
    expect(controller.element.querySelector('.player__rail-heading-time')).toBeNull();
  });

  it('gives a long rail a search and start times, and / goes to the search (f20)', async () => {
    const notes = Array.from({ length: 12 }, (_, i) => note(`n${i}`, 100 + i * 60, i === 3 ? 'Queue migration' : `Point ${i}`));
    const controller = await openWith(notes);

    expect(controller.element.querySelector<HTMLElement>('.player__rail-search')!.hidden).toBe(false);
    expect(controller.element.querySelector('.player__rail-heading-time')?.textContent).toBe('01:40');

    press(document.body, '/');
    const query = controller.element.querySelector<HTMLInputElement>('.player__rail-query')!;
    expect(document.activeElement).toBe(query);

    query.value = 'queue';
    query.dispatchEvent(new Event('input'));
    const shown = Array.from(controller.element.querySelectorAll<HTMLElement>('.player__rail-heading'))
      .filter((heading) => !heading.hidden)
      .map((heading) => heading.querySelector('.player__rail-heading-name')!.textContent);
    expect(shown).toEqual(['Queue migration']);
    // A matching heading keeps the lines said under it.
    const lines = Array.from(controller.element.querySelectorAll<HTMLElement>('.player__rail-line')).filter((line) => !line.hidden);
    expect(lines.map((line) => line.querySelector('.player__rail-text')!.textContent)).toEqual(['Said during Queue migration']);
  });

  it('merges marks that would overlap, and a merged mark opens its notes instead of seeking (f20)', async () => {
    // 15 s apart in an hour: closer than a mark is wide.
    const controller = await openWith([note('n1', 600, 'First'), note('n2', 615, 'Second'), note('n3', 2400, 'Alone')]);
    const marks = Array.from(controller.element.querySelectorAll<HTMLElement>('.player__mark'));
    expect(marks).toHaveLength(2);
    expect(marks[0].classList.contains('player__mark--merged')).toBe(true);
    expect(marks[0].title).toBe('2 notes here · zoom or use the list');

    const video = controller.element.querySelector<HTMLVideoElement>('.player__video')!;
    video.currentTime = 5;
    marks[0].click();
    expect(video.currentTime).toBe(5);
    expect(controller.element.querySelectorAll('.player__rail-heading--revealed')).toHaveLength(2);

    marks[1].click();
    expect(video.currentTime).toBe(2400);
  });

  it('swaps the fullscreen button for a way out while fullscreen (f15)', async () => {
    const controller = await openWith([note('n1', 100, 'One')]);
    const button = () => controller.element.querySelector<HTMLButtonElement>('.player__controls .player__icon:last-child')!;
    expect(button().title).toBe('Fullscreen');

    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => controller.element });
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(button().title).toBe('Leave fullscreen');

    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(button().title).toBe('Fullscreen');
  });
});
