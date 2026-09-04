/**
 * @file recordings/player/PlayerView.ts
 *
 * The playback modal (design card `f12`: picture controls, no transcript rail).
 *
 * The rail is not hidden when a recording has no transcript — it is not
 * rendered, and the video takes the full width. Note marks stay on the
 * scrubber either way, because the notes are the reason to scrub.
 */

import type { PlaybackManifest } from '../../shared/playback';
import { formatClock, seekFraction, toNoteMarks } from './playerFormat';

const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
};

export type PlayerViewCallbacks = {
  close: () => void;
  seekTo: (ms: number) => void;
  togglePlay: () => void;
  toggleFullscreen: () => void;
};

export class PlayerView {
  readonly overlay = $('div', 'player-overlay');
  readonly video = document.createElement('video');
  /** Picture-in-picture for the camera track (design f12, top-right 104×59). */
  readonly selfVideo = document.createElement('video');
  /** The microphone track has no picture — it only needs to be heard. */
  readonly micAudio = document.createElement('audio');
  private readonly dialog = $('article', 'player');
  private readonly title = $('span', 'player__title');
  private readonly date = $('span', 'player__date');
  private readonly stage = $('div', 'player__stage');
  private readonly status = $('p', 'player__status');
  private readonly track = $('span', 'player__track');
  private readonly played = $('span', 'player__played');
  private readonly playhead = $('span', 'player__playhead');
  private readonly marks = $('span', 'player__marks');
  private readonly clock = $('span', 'player__clock');
  private readonly playButton = document.createElement('button');
  private durationMs = 0;

  constructor(private readonly callbacks: PlayerViewCallbacks) {
    this.build();
  }

  private build(): void {
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-label', 'Recording player');

    // Header — 46px: back, title, divider, date, close.
    const header = $('div', 'player__header');
    const back = document.createElement('button');
    back.className = 'player__icon player__icon--back'; back.type = 'button';
    back.title = 'Back to recording details'; back.setAttribute('aria-label', 'Close player');
    back.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 2L3.5 6l4 4"/></svg>';
    back.addEventListener('click', () => this.callbacks.close());

    const close = document.createElement('button');
    close.className = 'player__close'; close.type = 'button';
    close.title = 'Close player'; close.setAttribute('aria-label', 'Close player');
    close.textContent = '×';
    close.addEventListener('click', () => this.callbacks.close());

    header.append(back, this.title, $('span', 'player__divider'), this.date, close);

    // Stage — the picture, with every control on it.
    this.video.className = 'player__video';
    this.video.setAttribute('playsinline', '');
    this.video.preload = 'metadata';
    this.selfVideo.className = 'player__selfcam';
    this.selfVideo.setAttribute('playsinline', '');
    this.selfVideo.preload = 'metadata';
    // Auxiliary tracks are driven by the clock, never by their own controls,
    // and they must never contribute a second copy of the tab audio.
    this.selfVideo.muted = true;
    this.selfVideo.hidden = true;
    this.micAudio.preload = 'metadata';
    this.micAudio.hidden = true;
    this.stage.append(this.video, this.selfVideo, this.micAudio, $('span', 'player__scrim'));

    const scrub = $('div', 'player__scrub');
    const hit = $('span', 'player__hit');
    hit.setAttribute('role', 'slider');
    hit.setAttribute('aria-label', 'Seek');
    hit.tabIndex = 0;
    this.track.append(this.played, this.marks, this.playhead);
    hit.append(this.track);
    hit.addEventListener('click', (event) => {
      const fraction = seekFraction(event.clientX, hit.getBoundingClientRect());
      this.callbacks.seekTo(fraction * this.durationMs);
    });
    scrub.append(hit);

    const controls = $('div', 'player__controls');
    this.playButton.className = 'player__play'; this.playButton.type = 'button';
    this.playButton.addEventListener('click', () => this.callbacks.togglePlay());
    this.clock.className = 'player__clock';
    const fullscreen = document.createElement('button');
    fullscreen.className = 'player__icon player__icon--on-picture'; fullscreen.type = 'button';
    fullscreen.title = 'Fullscreen'; fullscreen.setAttribute('aria-label', 'Fullscreen');
    fullscreen.innerHTML = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 5V1.5H5M9 1.5h3.5V5M12.5 9v3.5H9M5 12.5H1.5V9"/></svg>';
    fullscreen.addEventListener('click', () => this.callbacks.toggleFullscreen());
    controls.append(this.playButton, this.clock, fullscreen);

    this.stage.append(scrub, controls, this.status);
    this.dialog.append(header, this.stage);
    this.overlay.append(this.dialog);
    // Clicking the scrim closes; clicking the dialog must not.
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.callbacks.close();
    });
    this.setPlaying(false);
  }

  /** Renders everything the manifest determines; sources are attached separately. */
  render(manifest: PlaybackManifest): void {
    this.title.textContent = manifest.title;
    this.date.textContent = new Date(manifest.createdAt)
      .toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      .toUpperCase();
    this.durationMs = manifest.durationMs ?? 0;
    this.renderMarks(manifest);
    this.setPosition(0);
  }

  private renderMarks(manifest: PlaybackManifest): void {
    this.marks.replaceChildren();
    for (const mark of toNoteMarks(manifest.notations, this.durationMs)) {
      const el = $('span', `player__mark${mark.named ? '' : ' player__mark--unnamed'}`);
      el.style.left = `${mark.leftPct}%`;
      el.style.width = `${mark.widthPct}%`;
      el.title = mark.label;
      el.addEventListener('click', (event) => {
        // A mark is a seek target, not part of the track behind it.
        event.stopPropagation();
        this.callbacks.seekTo(mark.startMs);
      });
      this.marks.append(el);
    }
  }

  /** Called from timeupdate; keeps the playhead and clock on the same source. */
  setPosition(positionMs: number, durationMs = this.durationMs): void {
    if (durationMs > 0) this.durationMs = durationMs;
    const pct = this.durationMs > 0 ? Math.min(100, (positionMs / this.durationMs) * 100) : 0;
    this.played.style.width = `${pct}%`;
    this.playhead.style.left = `${pct}%`;
    this.clock.textContent = `${formatClock(positionMs)} / ${formatClock(this.durationMs)}`;
  }

  setPlaying(playing: boolean): void {
    this.playButton.title = playing ? 'Pause' : 'Play';
    this.playButton.setAttribute('aria-label', this.playButton.title);
    this.playButton.innerHTML = playing
      ? '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1.5" width="3" height="9" rx="1"/><rect x="7" y="1.5" width="3" height="9" rx="1"/></svg>'
      : '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.8l7 4.2-7 4.2z"/></svg>';
  }

  /** Reveals the camera picture only once a self-video track is actually attached. */
  showSelfCam(show: boolean): void {
    this.selfVideo.hidden = !show;
  }

  /** A message on the picture — the recording is unreachable, not merely paused. */
  setStatus(message: string | null): void {
    this.status.textContent = message ?? '';
    this.status.hidden = !message;
    this.stage.classList.toggle('player__stage--quiet', Boolean(message));
  }
}
