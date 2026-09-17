import { PlayerView, type PlayerViewCallbacks } from '../PlayerView';
import type { PlaybackManifest, PlaybackTopic } from '../../../shared/playback';

function callbacks(over: Partial<PlayerViewCallbacks> = {}): PlayerViewCallbacks {
  return {
    close: jest.fn(), seekTo: jest.fn(), togglePlay: jest.fn(), toggleFullscreen: jest.fn(),
    toggleFile: jest.fn(), setVolume: jest.fn(), toggleTrackMuted: jest.fn(),
    setSkipSeconds: jest.fn(), setSpeed: jest.fn(),
    ...over,
  };
}

/** The project's `lib` predates iterable NodeLists. */
function all(root: HTMLElement, selector: string): HTMLElement[] {
  return Array.prototype.slice.call(root.querySelectorAll(selector)) as HTMLElement[];
}

function topic(id: string, keywords: string[], spans: Array<[number, number]>, importance = 0.5): PlaybackTopic {
  return {
    id,
    keywords,
    spans: spans.map(([tStartMs, tEndMs]) => ({ tStartMs, tEndMs })),
    totalMs: spans.reduce((total, [start, end]) => total + (end - start), 0),
    importance,
  };
}

function manifest(topics: PlaybackTopic[]): PlaybackManifest {
  return {
    recordingId: 'r1',
    title: 'Weekly sync',
    createdAt: 1_700_000_000_000,
    durationMs: 1_200_000,
    transcriptStatus: 'ready',
    notations: [],
    topics,
    tracks: [],
  };
}

const REDIS = topic('t_redis', ['redis', 'timeout', 'workers', 'pool'], [[0, 300_000], [900_000, 1_200_000]], 0.9);
const HIRING = topic('t_hiring', ['interview', 'frontend'], [[300_000, 900_000]], 0.4);

describe('PlayerView topics', () => {
  it('draws one band per span, not one per topic (MODEL-04)', () => {
    const view = new PlayerView(callbacks());
    view.render(manifest([REDIS, HIRING]));

    const bands = all(view.overlay, '.player__topic-span');
    expect(bands).toHaveLength(3);
    expect(bands.map((b) => b.style.left)).toEqual(['0%', '25%', '75%']);
  });

  it('gives a recurring topic the same shade in both of its bands', () => {
    const view = new PlayerView(callbacks());
    view.render(manifest([REDIS, HIRING]));

    const bands = all(view.overlay, '.player__topic-span');
    expect(bands[0].className).toContain('player__topic-span--0');
    expect(bands[2].className).toContain('player__topic-span--0');
    expect(bands[1].className).toContain('player__topic-span--1');
  });

  it('labels a band with its keywords, so hovering says what it is', () => {
    const view = new PlayerView(callbacks());
    view.render(manifest([REDIS, HIRING]));

    const band = view.overlay.querySelector<HTMLElement>('.player__topic-span')!;
    expect(band.title).toBe('redis · timeout · workers · pool');
  });

  it('seeks to a band without also seeking the track behind it', () => {
    const seekTo = jest.fn();
    const view = new PlayerView(callbacks({ seekTo }));
    view.render(manifest([REDIS, HIRING]));

    const bands = all(view.overlay, '.player__topic-span');
    bands[2].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(seekTo).toHaveBeenCalledTimes(1);
    expect(seekTo).toHaveBeenCalledWith(900_000);
  });

  it('lists topics in UI-02 form, strongest first', () => {
    const view = new PlayerView(callbacks());
    view.render(manifest([REDIS, HIRING]));

    const rows = all(view.overlay, '.player__topic');
    expect(rows.map((row) => row.querySelector('.player__topic-label')!.textContent)).toEqual([
      'redis · timeout · workers · pool',
      'interview · frontend',
    ]);
    expect(rows.map((row) => row.querySelector('.player__topic-meta')!.textContent)).toEqual([
      // "2×" marks the subject the conversation came back to.
      '2×  10 min',
      '10 min',
    ]);
  });

  it('seeks a topic row to where the subject first came up, and closes the menu', () => {
    const seekTo = jest.fn();
    const view = new PlayerView(callbacks({ seekTo }));
    view.render(manifest([REDIS, HIRING]));
    view.toggleTopics();

    const row = view.overlay.querySelector<HTMLElement>('.player__topic')!;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(seekTo).toHaveBeenCalledWith(0);
    expect(view.overlay.querySelector<HTMLElement>('.player__menu--topics')!.hidden).toBe(true);
  });

  it('counts the topics on its trigger', () => {
    const view = new PlayerView(callbacks());
    view.render(manifest([REDIS, HIRING]));

    const trigger = all(view.overlay, '.player__files')
      .find((b) => b.textContent?.startsWith('TOPICS'))!;
    expect(trigger.hidden).toBe(false);
    expect(trigger.textContent).toBe('TOPICS2');
  });

  it('hides itself entirely for a recording with no current analysis', () => {
    const view = new PlayerView(callbacks());
    view.render(manifest([]));

    const trigger = all(view.overlay, '.player__files')
      .find((b) => b.textContent?.startsWith('TOPICS'))!;
    // An empty "TOPICS 0" would promise something the player cannot deliver.
    expect(trigger.hidden).toBe(true);
    expect(view.overlay.querySelector<HTMLElement>('.player__topics-band')!.hidden).toBe(true);
    expect(view.overlay.querySelectorAll('.player__topic')).toHaveLength(0);
  });

  it('refuses to open a TOPICS list it is not showing', () => {
    const view = new PlayerView(callbacks());
    view.render(manifest([]));
    expect(view.toggleTopics()).toBe(false);
  });

  it("replaces the previous recording's bands rather than appending to them", () => {
    const view = new PlayerView(callbacks());
    view.render(manifest([REDIS, HIRING]));
    view.render(manifest([HIRING]));

    expect(view.overlay.querySelectorAll('.player__topic-span')).toHaveLength(1);
    expect(view.overlay.querySelectorAll('.player__topic')).toHaveLength(1);
  });

  it('closes the TOPICS list alongside every other popover', () => {
    const view = new PlayerView(callbacks());
    view.render(manifest([REDIS]));
    view.toggleTopics();
    expect(view.overlay.querySelector<HTMLElement>('.player__menu--topics')!.hidden).toBe(false);

    view.closePopovers();
    expect(view.overlay.querySelector<HTMLElement>('.player__menu--topics')!.hidden).toBe(true);
  });

  it('draws no band when the recording has no known duration', () => {
    const view = new PlayerView(callbacks());
    view.render({ ...manifest([REDIS]), durationMs: undefined });

    // The list still renders — a topic's words are useful without a scrubber.
    expect(view.overlay.querySelectorAll('.player__topic-span')).toHaveLength(0);
    expect(view.overlay.querySelectorAll('.player__topic')).toHaveLength(1);
  });
});
