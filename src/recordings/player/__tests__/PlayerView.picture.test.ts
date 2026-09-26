/**
 * The picture is a play/pause control of its own, and it answers with a centre
 * bloom — but only for changes the user asked for.
 */
import { PlayerView, type PlayerViewCallbacks } from '../PlayerView';

function callbacks(over: Partial<PlayerViewCallbacks> = {}): PlayerViewCallbacks {
  return {
    close: jest.fn(), seekTo: jest.fn(), togglePlay: jest.fn(), toggleFullscreen: jest.fn(),
    toggleFile: jest.fn(), setVolume: jest.fn(), toggleTrackMuted: jest.fn(),
    setSkipSeconds: jest.fn(), setSpeed: jest.fn(),
    ...over,
  };
}

const flash = (view: PlayerView) => view.overlay.querySelector<HTMLElement>('.player__flash')!;
const blooming = (view: PlayerView) => flash(view).classList.contains('player__flash--on');
/** The glyph drawn in the bloom: bars for paused, a triangle for playing. */
const glyph = (view: PlayerView) => (flash(view).querySelector('rect') ? 'pause' : flash(view).querySelector('path') ? 'play' : null);

describe('PlayerView picture', () => {
  it('plays and pauses on a click, and blooms the state playback reached', () => {
    const togglePlay = jest.fn();
    const view = new PlayerView(callbacks({ togglePlay }));

    view.video.click();
    expect(togglePlay).toHaveBeenCalledTimes(1);
    expect(blooming(view)).toBe(false);
    view.setPlaying(true);
    expect(blooming(view)).toBe(true);
    expect(glyph(view)).toBe('play');

    view.video.click();
    view.setPlaying(false);
    expect(glyph(view)).toBe('pause');
  });

  it('does not bloom for a change nobody asked for, like autoplay', () => {
    const view = new PlayerView(callbacks());
    view.setPlaying(true);
    expect(blooming(view)).toBe(false);
  });

  it('blooms once per request, not on every later change', () => {
    const view = new PlayerView(callbacks());
    view.armPlayFlash();
    view.setPlaying(true);
    flash(view).classList.remove('player__flash--on');
    view.setPlaying(false); // the file ended
    expect(blooming(view)).toBe(false);
  });

  it('a click that closes an open menu only closes it', () => {
    const togglePlay = jest.fn();
    const view = new PlayerView(callbacks({ togglePlay }));
    document.body.append(view.overlay);
    view.overlay.querySelector<HTMLButtonElement>('[aria-label="Playback settings"]')!.click();
    expect(view.overlay.querySelector<HTMLElement>('.player__menu--settings')!.hidden).toBe(false);

    view.video.click();
    expect(togglePlay).not.toHaveBeenCalled();
    expect(view.overlay.querySelector<HTMLElement>('.player__menu--settings')!.hidden).toBe(true);
    view.overlay.remove();
  });

  it('draws a gear for playback settings', () => {
    const view = new PlayerView(callbacks());
    const icon = view.overlay.querySelector('[aria-label="Playback settings"] svg')!;
    // A toothed outline around a hub, not a sun's loose rays.
    expect(icon.querySelector('path')!.getAttribute('d')).toMatch(/^M.*A.*Z$/);
    expect(icon.querySelector('circle')).not.toBeNull();
  });
});
