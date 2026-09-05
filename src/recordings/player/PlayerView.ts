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
import { audioTracks, shownCount, type TrackDescriptor } from './playerTracks';
import { KEYBOARD_HELP, SKIP_STEPS, SPEED_STEPS } from './playerKeymap';

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
  toggleFile: (fileId: string) => void;
  setVolume: (fileId: string, level: number) => void;
  toggleTrackMuted: (fileId: string) => void;
  setSkipSeconds: (seconds: number) => void;
  setSpeed: (rate: number) => void;
};

export class PlayerView {
  readonly overlay = $('div', 'player-overlay');
  readonly video = document.createElement('video');
  /** Auxiliary media elements, one per non-master track (never shared). */
  readonly auxiliaries = $('div', 'player__aux');
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
  private readonly filesButton = document.createElement('button');
  private readonly filesCount = $('span', 'player__files-count');
  private readonly filesMenu = $('div', 'player__menu player__menu--files');
  private readonly volumeButton = document.createElement('button');
  private readonly volumeMenu = $('div', 'player__menu player__menu--volume');
  private readonly settingsButton = document.createElement('button');
  private readonly settingsMenu = $('div', 'player__menu player__menu--settings');
  private readonly help = $('div', 'player__help');
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

    this.filesButton.className = 'player__files'; this.filesButton.type = 'button';
    this.filesButton.title = 'Which files are shown';
    this.filesButton.setAttribute('aria-haspopup', 'true');
    const filesLabel = $('span', 'player__files-label'); filesLabel.textContent = 'FILES';
    this.filesButton.append(filesLabel, this.filesCount);
    this.filesButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.togglePopover(this.filesMenu);
    });
    const filesWrap = $('span', 'player__popover');
    filesWrap.append(this.filesButton, this.filesMenu);

    header.append(back, this.title, $('span', 'player__divider'), filesWrap, this.date, close);

    // Stage — the picture, with every control on it.
    this.video.className = 'player__video';
    this.video.setAttribute('playsinline', '');
    this.video.preload = 'metadata';
    this.stage.append(this.video, this.auxiliaries, $('span', 'player__scrim'));

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
    this.volumeButton.className = 'player__icon player__icon--on-picture'; this.volumeButton.type = 'button';
    this.volumeButton.title = 'Volume · tab audio and microphone';
    this.volumeButton.setAttribute('aria-label', 'Volume');
    this.volumeButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h2.5L9 3v10L5.5 10H3z"/><path d="M11.5 6.2a2.6 2.6 0 010 3.6"/></svg>';
    this.volumeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.togglePopover(this.volumeMenu);
    });
    const volumeWrap = $('span', 'player__popover player__popover--up');
    volumeWrap.append(this.volumeButton, this.volumeMenu);

    this.settingsButton.className = 'player__icon player__icon--on-picture'; this.settingsButton.type = 'button';
    this.settingsButton.title = 'Skip step and speed';
    this.settingsButton.setAttribute('aria-label', 'Playback settings');
    this.settingsButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="2.1"/><path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8L3.5 3.5"/></svg>';
    this.settingsButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.togglePopover(this.settingsMenu);
    });
    const settingsWrap = $('span', 'player__popover player__popover--up');
    settingsWrap.append(this.settingsButton, this.settingsMenu);

    controls.append(this.playButton, this.clock, volumeWrap, settingsWrap, fullscreen);

    this.help.hidden = true;
    this.help.setAttribute('role', 'dialog');
    this.help.setAttribute('aria-label', 'Keyboard shortcuts');
    const helpTitle = $('p', 'player__help-title'); helpTitle.textContent = 'KEYBOARD';
    this.help.append(helpTitle);
    for (const row of KEYBOARD_HELP) {
      const line = $('div', 'player__help-row');
      const keys = $('span', 'player__help-keys'); keys.textContent = row.keys;
      const description = $('span', 'player__help-text'); description.textContent = row.description;
      line.append(keys, description);
      this.help.append(line);
    }
    this.stage.append(scrub, controls, this.help, this.status);
    this.dialog.append(header, this.stage);
    this.overlay.append(this.dialog);
    // Clicking the scrim closes; clicking the dialog must not. Any click inside
    // the dialog also dismisses an open popover, which is what makes them feel
    // like menus rather than panels.
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) return this.callbacks.close();
      this.closePopovers();
    });
    this.filesMenu.hidden = true;
    this.volumeMenu.hidden = true;
    this.settingsMenu.hidden = true;
    for (const menu of [this.filesMenu, this.volumeMenu, this.settingsMenu]) this.keepOpen(menu);
    this.setPlaying(false);
  }

  /** Popovers swallow their own clicks; without this a drag ends by closing them. */
  private keepOpen(menu: HTMLElement): void {
    for (const type of ['click', 'pointerdown', 'mousedown'] as const) {
      menu.addEventListener(type, (event) => event.stopPropagation());
    }
  }

  private togglePopover(menu: HTMLElement): void {
    const opening = menu.hidden;
    this.closePopovers();
    menu.hidden = !opening;
  }

  closePopovers(): void {
    this.filesMenu.hidden = true;
    this.volumeMenu.hidden = true;
    this.settingsMenu.hidden = true;
  }

  /** Returns whether the map ended up open, so Escape can close it first. */
  toggleHelp(force?: boolean): boolean {
    this.help.hidden = force === undefined ? !this.help.hidden : !force;
    return !this.help.hidden;
  }

  get helpOpen(): boolean { return !this.help.hidden; }

  /**
   * Renders the settings rows. Subtitles and quality are absent by design —
   * "rows that do not apply are not rendered", and this player has one
   * rendition and no subtitle track.
   */
  setSettings(skipSeconds: number, speed: number): void {
    this.settingsMenu.replaceChildren();
    this.settingsMenu.append(
      this.choiceRow('Arrow-key skip', SKIP_STEPS.map((step) => ({
        label: `${step}s`, active: step === skipSeconds, pick: () => this.callbacks.setSkipSeconds(step),
      }))),
      this.choiceRow('Speed', SPEED_STEPS.map((rate) => ({
        label: rate === 1 ? '1×' : `${rate}×`, active: rate === speed, pick: () => this.callbacks.setSpeed(rate),
      }))),
    );
  }

  /**
   * Vertical fader driven by pointer events. Pointer capture is what makes the
   * drag survive leaving the element, which is most of a fader's travel.
   */
  private buildFader(level: number, label: string, onChange: (level: number) => void): HTMLElement {
    const track = $('div', 'player__fader-track');
    const fill = $('span', 'player__fader-fill');
    const thumb = $('span', 'player__fader-thumb');
    track.append(fill, thumb);
    track.tabIndex = 0;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', `${label} volume`);
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');

    let current = level;
    const paint = () => {
      const pct = Math.round(current * 100);
      fill.style.height = `${pct}%`;
      thumb.style.bottom = `calc(${pct}% - 7px)`;
      track.setAttribute('aria-valuenow', String(pct));
    };
    const setFromPointer = (clientY: number) => {
      const rect = track.getBoundingClientRect();
      // Inverted: the top of a fader is loud.
      current = Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height));
      paint();
      onChange(current);
    };

    // Listeners go on the document for the life of the gesture rather than
    // relying on pointer capture: capture retargets inconsistently here, and a
    // fader's travel takes the pointer off the 6px track almost immediately.
    track.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setFromPointer(event.clientY);
      const onMove = (move: PointerEvent) => setFromPointer(move.clientY);
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
    track.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowUp' ? 0.05 : event.key === 'ArrowDown' ? -0.05 : 0;
      if (!step) return;
      event.preventDefault();
      event.stopPropagation();
      current = Math.min(1, Math.max(0, current + step));
      paint();
      onChange(current);
    });

    paint();
    return track;
  }

  private choiceRow(label: string, options: Array<{ label: string; active: boolean; pick: () => void }>): HTMLElement {
    const row = $('div', 'player__setting');
    const name = $('span', 'player__setting-label'); name.textContent = label;
    const choices = $('span', 'player__setting-choices');
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `player__chip${option.active ? ' player__chip--active' : ''}`;
      button.textContent = option.label;
      button.setAttribute('aria-pressed', String(option.active));
      button.addEventListener('click', (event) => { event.stopPropagation(); option.pick(); });
      choices.append(button);
    }
    row.append(name, choices);
    return row;
  }

  /**
   * Renders the FILES list and the volume faders. Called on open and after each
   * toggle, so the trigger's count and the checkboxes cannot drift apart.
   */
  setTracks(tracks: TrackDescriptor[], levels: ReadonlyMap<string, number>, muted: ReadonlySet<string>): void {
    this.filesCount.textContent = String(shownCount(tracks));
    // A recording with one file has nothing to choose between.
    this.filesButton.hidden = tracks.length < 2;

    this.filesMenu.replaceChildren();
    for (const track of tracks) {
      const row = document.createElement('button');
      const on = track.shown && track.available;
      row.className = `player__file${on ? ' player__file--on' : ''}${track.available ? '' : ' player__file--unavailable'}`;
      row.type = 'button';
      row.disabled = !track.available;
      row.setAttribute('role', 'menuitemcheckbox');
      row.setAttribute('aria-checked', String(on));
      const check = $('span', 'player__file-check');
      const label = $('span', 'player__file-label'); label.textContent = track.label;
      const format = $('span', 'player__file-format');
      // Says why it is not playing, rather than showing a checkbox that does nothing.
      format.textContent = track.available ? track.format : 'UNAVAILABLE';
      row.append(check, label, format);
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.toggleFile(track.fileId);
      });
      this.filesMenu.append(row);
    }

    this.volumeMenu.replaceChildren();
    const faders = audioTracks(tracks);
    this.volumeButton.hidden = faders.length === 0;
    for (const track of faders) {
      const column = $('div', 'player__fader');
      column.dataset.fileId = track.fileId;
      const level = levels.get(track.fileId) ?? 1;
      const readout = $('span', 'player__fader-level');
      readout.textContent = muted.has(track.fileId) ? 'MUTED' : `${Math.round(level * 100)}`;
      readout.dataset.role = 'level';
      // A custom fader rather than <input type=range>: vertical range support is
      // inconsistent — it renders, takes the initial click, then refuses to track
      // a drag — and the design's fader is a bespoke control regardless.
      const slider = this.buildFader(level, track.label, (next) => this.callbacks.setVolume(track.fileId, next));
      // Clicking the name mutes that track — the design's affordance, not a label.
      const name = document.createElement('button');
      name.type = 'button';
      name.className = `player__fader-name${muted.has(track.fileId) ? ' player__fader-name--muted' : ''}`;
      name.dataset.role = 'name';
      name.textContent = track.label;
      name.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.toggleTrackMuted(track.fileId);
      });
      column.append(readout, slider, name);
      this.volumeMenu.append(column);
    }
  }

  /**
   * Updates one fader's readout without rebuilding the menu. Re-rendering on
   * every pointermove destroyed the very node being dragged, which is why the
   * fader tracked erratically.
   */
  updateFader(fileId: string, level: number, muted: boolean): void {
    const column = this.volumeMenu.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(fileId)}"]`);
    if (!column) return;
    const readout = column.querySelector<HTMLElement>('[data-role="level"]');
    if (readout) readout.textContent = muted ? 'MUTED' : `${Math.round(level * 100)}`;
    const name = column.querySelector<HTMLElement>('[data-role="name"]');
    name?.classList.toggle('player__fader-name--muted', muted);
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

  /**
   * Creates a dedicated element for one auxiliary track. One element per track,
   * never a shared one: two tracks of the same kind would otherwise overwrite
   * each other's source and only the last would be heard.
   */
  addAuxiliary(kind: 'video' | 'audio'): HTMLMediaElement {
    const element = document.createElement(kind);
    element.preload = 'metadata';
    if (kind === 'video') {
      const video = element as HTMLVideoElement;
      video.className = 'player__selfcam';
      video.setAttribute('playsinline', '');
      // The camera carries no audio; unmuting it would double the tab's.
      video.muted = true;
    } else {
      element.hidden = true;
    }
    this.auxiliaries.append(element);
    return element;
  }

  clearAuxiliaries(): void {
    for (const element of Array.from(this.auxiliaries.children) as HTMLMediaElement[]) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
    this.auxiliaries.replaceChildren();
  }

  /** A message on the picture — the recording is unreachable, not merely paused. */
  setStatus(message: string | null): void {
    this.status.textContent = message ?? '';
    this.status.hidden = !message;
    this.stage.classList.toggle('player__stage--quiet', Boolean(message));
  }
}
