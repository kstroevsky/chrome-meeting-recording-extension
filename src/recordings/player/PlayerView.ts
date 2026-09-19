/**
 * @file recordings/player/PlayerView.ts
 *
 * The playback modal: controls on the picture (design card `f12`), and — for a
 * recording with a transcript — the rail beside it and subtitles on it (`f10`).
 *
 * The rail is not hidden when a recording has no transcript — it is not
 * rendered, the header loses its toggle, and the video takes the full width.
 * Note marks stay on the scrubber either way, because the notes are the reason
 * to scrub.
 */

import type { PlaybackManifest } from '../../shared/playback';
import { formatClock, mergeNoteMarks, seekFraction, toNoteMarks, toTopicBands } from './playerFormat';
import { activeSegmentIndex, noteAt, railItems, sortSegments, toSrt } from './playerTranscript';
import type { RecordingNotation } from '../../shared/notations';
import type { TranscriptSegment } from '../../shared/transcript';
import { audioTracks, shownCount, type TrackDescriptor } from './playerTracks';
import { describeTopics, recurrenceHint } from './playerTopics';
import { KEYBOARD_HELP, SKIP_STEPS, SPEED_STEPS } from './playerKeymap';

/** The header dropdowns' chevron (f12): 8px, in the faint ink. */
const DROPDOWN_CHEVRON = '<svg class="player__files-chevron" width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5l3 3 3-3"/></svg>';

const RAIL_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/></svg>';
const ENTER_FULLSCREEN_ICON = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 5V1.5H5M9 1.5h3.5V5M12.5 9v3.5H9M5 12.5H1.5V9"/></svg>';
const LEAVE_FULLSCREEN_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 2v3H2M9 2v3h3M5 12V9H2M9 12V9h3"/></svg>';
const PENCIL_ICON = '<svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.5 1.7l2.8 2.8-8 8H3.5v-2.8l8-8z"/></svg>';
const TICK_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 5.2L4 7.4l4.2-4.6"/></svg>';
const SEARCH_ICON = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="5.2" cy="5.2" r="3.4"/><path d="M7.8 7.8l2.4 2.4"/></svg>';

/**
 * A recording with this many notes gets the rail's index treatment (f20): a
 * search field, and each heading's start time, so the list reads as contents.
 * Below it the headings are few enough to scroll (f10, f18).
 */
export const RAIL_INDEX_NOTES = 12;

const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
};

/**
 * Why the picture is empty (f16): what happened, what is still safe, and the
 * one or two things worth doing about it.
 */
export type PlayerStatus = {
  title: string;
  body?: string;
  actions?: Array<'folder' | 'remove'>;
};

export type PlayerViewCallbacks = {
  close: () => void;
  /** Present when the page can open the recording's Drive folder. */
  openFolder?: () => void;
  /** Present when the page can take the recording out of history. */
  remove?: () => void;
  seekTo: (ms: number) => void;
  togglePlay: () => void;
  toggleFullscreen: () => void;
  toggleFile: (fileId: string) => void;
  setVolume: (fileId: string, level: number) => void;
  toggleTrackMuted: (fileId: string) => void;
  setSkipSeconds: (seconds: number) => void;
  setSpeed: (rate: number) => void;
  /** Renames a note from its rail heading (f18); resolves false when the write failed. */
  renameNote?: (id: string, text: string) => Promise<boolean>;
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
  private readonly status = $('div', 'player__status');
  private readonly track = $('span', 'player__track');
  private readonly played = $('span', 'player__played');
  private readonly playhead = $('span', 'player__playhead');
  private readonly marks = $('span', 'player__marks');
  /** Topic spans, a band of their own under the scrubber (ADR-0007 §8). */
  private readonly topicBand = $('span', 'player__topics-band');
  private readonly clock = $('span', 'player__clock');
  private readonly playButton = document.createElement('button');
  private readonly filesButton = document.createElement('button');
  private readonly filesCount = $('span', 'player__files-count');
  private readonly filesMenu = $('div', 'player__menu player__menu--files');
  private readonly topicsButton = document.createElement('button');
  private readonly topicsCount = $('span', 'player__files-count');
  private readonly topicsMenu = $('div', 'player__menu player__menu--topics');
  private readonly volumeButton = document.createElement('button');
  private readonly volumeMenu = $('div', 'player__menu player__menu--volume');
  private readonly settingsButton = document.createElement('button');
  private readonly settingsMenu = $('div', 'player__menu player__menu--settings');
  private readonly help = $('div', 'player__help');
  /** The picture and, when there is a transcript, the rail beside it (f10). */
  private readonly body = $('div', 'player__body');
  private readonly rail = $('aside', 'player__rail');
  private readonly railCount = $('span', 'player__rail-count');
  private readonly railList = $('div', 'player__rail-list');
  private readonly railToggle = document.createElement('button');
  private readonly subtitle = $('div', 'player__subtitle');
  /** Fullscreen only (f15): the name and date move onto the picture, top left. */
  private readonly pictureTitle = $('div', 'player__picture-title');
  private readonly pictureName = $('span', 'player__picture-name');
  private readonly pictureDate = $('span', 'player__picture-date');
  private readonly fullscreenButton = document.createElement('button');
  /** Fullscreen only: brings back a rail its own hide button put away. */
  private readonly pictureRailButton = document.createElement('button');
  private readonly railSearch = $('div', 'player__rail-search');
  private readonly railQuery = document.createElement('input');
  private readonly railEmpty = $('p', 'player__rail-empty');
  /** Time-sorted transcript lines; empty means no rail at all, not a hidden one. */
  private segments: TranscriptSegment[] = [];
  private notations: RecordingNotation[] = [];
  private lineElements: HTMLElement[] = [];
  /** The rail's rows with the text each answers to, for search (f20). */
  private railEntries: Array<{ element: HTMLElement; kind: 'heading' | 'line'; noteId: string | null; text: string }> = [];
  private readonly headings = new Map<string, HTMLElement>();
  private query = '';
  private renamingId: string | null = null;
  private activeIndex = -1;
  private railOpen = true;
  private subtitlesOn = true;
  private transcriptTitle = 'transcript';
  /** When the user last moved the rail themselves; auto-follow waits it out. */
  private userScrolledAt = 0;
  private programmaticScroll = false;
  /** The last position painted, so a transcript arriving late starts in step. */
  private positionMs = 0;
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
    this.filesButton.insertAdjacentHTML('beforeend', DROPDOWN_CHEVRON);
    this.filesButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.togglePopover(this.filesMenu);
    });
    const filesWrap = $('span', 'player__popover');
    filesWrap.append(this.filesButton, this.filesMenu);

    this.topicsButton.className = 'player__files'; this.topicsButton.type = 'button';
    this.topicsButton.title = 'What this recording was about';
    this.topicsButton.setAttribute('aria-haspopup', 'true');
    const topicsLabel = $('span', 'player__files-label'); topicsLabel.textContent = 'TOPICS';
    this.topicsButton.append(topicsLabel, this.topicsCount);
    this.topicsButton.insertAdjacentHTML('beforeend', DROPDOWN_CHEVRON);
    this.topicsButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.togglePopover(this.topicsMenu);
    });
    const topicsWrap = $('span', 'player__popover');
    topicsWrap.append(this.topicsButton, this.topicsMenu);

    // Shown only when there is a transcript: the header loses it otherwise (f11/f12).
    this.railToggle.className = 'player__rail-toggle'; this.railToggle.type = 'button';
    this.railToggle.hidden = true;
    this.railToggle.innerHTML = RAIL_ICON;
    this.railToggle.addEventListener('click', () => this.setRailOpen(!this.railOpen));

    header.append(back, this.title, $('span', 'player__divider'), filesWrap, topicsWrap, this.railToggle, this.date, close);

    // Stage — the picture, with every control on it.
    this.video.className = 'player__video';
    this.video.setAttribute('playsinline', '');
    this.video.preload = 'metadata';
    this.pictureTitle.append(this.pictureName, this.pictureDate);
    this.stage.append(this.video, this.auxiliaries, $('span', 'player__scrim'), this.pictureTitle);

    const scrub = $('div', 'player__scrub');
    const hit = $('span', 'player__hit');
    hit.setAttribute('role', 'slider');
    hit.setAttribute('aria-label', 'Seek');
    hit.tabIndex = 0;
    // Order is paint order: topics sit behind, notes and the playhead in front.
    // A topic band drawn over a note mark would hide the thing the user is
    // scrubbing *for*.
    this.track.append(this.topicBand, this.played, this.marks, this.playhead);
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
    this.fullscreenButton.className = 'player__icon player__icon--on-picture'; this.fullscreenButton.type = 'button';
    this.fullscreenButton.addEventListener('click', () => this.callbacks.toggleFullscreen());
    this.setFullscreen(false);
    this.pictureRailButton.className = 'player__icon player__icon--on-picture player__picture-rail'; this.pictureRailButton.type = 'button';
    this.pictureRailButton.title = 'Show the transcript'; this.pictureRailButton.setAttribute('aria-label', 'Show the transcript');
    this.pictureRailButton.innerHTML = RAIL_ICON;
    this.pictureRailButton.hidden = true;
    this.pictureRailButton.addEventListener('click', () => this.setRailOpen(true));
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

    controls.append(this.playButton, this.clock, volumeWrap, settingsWrap, this.pictureRailButton, this.fullscreenButton);

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
    this.subtitle.hidden = true;
    this.subtitle.setAttribute('aria-live', 'off');
    this.stage.append(this.subtitle, scrub, controls, this.help, this.status);
    this.buildRail();
    this.body.append(this.stage, this.rail);
    this.dialog.append(header, this.body);
    this.overlay.append(this.dialog);
    // Clicking the scrim closes; clicking the dialog must not. Any click inside
    // the dialog also dismisses an open popover, which is what makes them feel
    // like menus rather than panels.
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) return this.callbacks.close();
      this.closePopovers();
    });
    this.filesMenu.hidden = true;
    this.topicsMenu.hidden = true;
    this.volumeMenu.hidden = true;
    this.settingsMenu.hidden = true;
    for (const menu of [this.filesMenu, this.topicsMenu, this.volumeMenu, this.settingsMenu]) this.keepOpen(menu);
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
    this.topicsMenu.hidden = true;
    this.volumeMenu.hidden = true;
    this.settingsMenu.hidden = true;
  }

  /** Opens the TOPICS list, for the keyboard binding. False when there are none. */
  toggleTopics(): boolean {
    if (this.topicsButton.hidden) return false;
    this.togglePopover(this.topicsMenu);
    return !this.topicsMenu.hidden;
  }

  /** Returns whether the map ended up open, so Escape can close it first. */
  toggleHelp(force?: boolean): boolean {
    this.help.hidden = force === undefined ? !this.help.hidden : !force;
    return !this.help.hidden;
  }

  get helpOpen(): boolean { return !this.help.hidden; }

  /**
   * Renders the settings rows. Quality is absent by design — "rows that do not
   * apply are not rendered", and this player has one rendition — and Subtitles
   * appears only when the recording has a transcript to draw them from.
   */
  setSettings(skipSeconds: number, speed: number): void {
    this.settingsMenu.replaceChildren();
    // Subtitles apply once the recording has a transcript to draw them from (f10).
    if (this.segments.length) {
      this.settingsMenu.append(this.choiceRow('Subtitles', [true, false].map((on) => ({
        label: on ? 'On' : 'Off', active: this.subtitlesOn === on, pick: () => { this.setSubtitles(on); this.setSettings(skipSeconds, speed); },
      }))));
    }
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
    this.pictureName.textContent = manifest.title;
    this.durationMs = manifest.durationMs ?? 0;
    // `JUL 19 · 22:40`: the day it was made, and how long it runs (f12).
    const day = new Date(manifest.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
    this.date.textContent = this.durationMs ? `${day} · ${formatClock(this.durationMs)}` : day;
    this.pictureDate.textContent = this.date.textContent;
    this.notations = manifest.notations;
    this.renderMarks(manifest);
    this.renderTopics(manifest);
    this.setPosition(0);
  }

  /**
   * Draws the topic band and fills the TOPICS list.
   *
   * Both disappear entirely when a recording has no current analysis — never
   * analysed, still running, or stale. An empty "TOPICS 0" would be a promise
   * the player cannot keep, and the recording is perfectly watchable without
   * it; this mirrors FILES hiding itself for a single-file recording.
   */
  private renderTopics(manifest: PlaybackManifest): void {
    const topics = describeTopics(manifest.topics);
    this.topicsButton.hidden = topics.length === 0;
    this.topicsCount.textContent = String(topics.length);

    this.topicBand.replaceChildren();
    this.topicBand.hidden = topics.length === 0;
    for (const band of toTopicBands(manifest.topics, this.durationMs)) {
      const el = $('span', `player__topic-span player__topic-span--${band.shade}`);
      el.style.left = `${band.leftPct}%`;
      el.style.width = `${band.widthPct}%`;
      el.title = band.label;
      el.addEventListener('click', (event) => {
        // A band is a seek target, not part of the track behind it.
        event.stopPropagation();
        this.callbacks.seekTo(band.startMs);
      });
      this.topicBand.append(el);
    }

    this.topicsMenu.replaceChildren();
    for (const topic of topics) {
      const row = document.createElement('button');
      row.className = 'player__topic';
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      const dot = $('span', `player__topic-dot player__topic-dot--${topic.shade}`);
      const label = $('span', 'player__topic-label'); label.textContent = topic.label;
      const meta = $('span', 'player__topic-meta');
      const repeats = recurrenceHint(topic);
      // "2×" says the conversation came back to this, which is the whole point
      // of separating global topics from temporal segments (MODEL-04).
      meta.textContent = repeats ? `${repeats}  ${topic.duration}` : topic.duration;
      row.append(dot, label, meta);
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        this.callbacks.seekTo(topic.seekMs);
        this.closePopovers();
      });
      this.topicsMenu.append(row);
    }
  }

  private renderMarks(manifest: PlaybackManifest): void {
    this.marks.replaceChildren();
    for (const group of mergeNoteMarks(toNoteMarks(manifest.notations, this.durationMs))) {
      const merged = group.notes.length > 1;
      const el = $('span', `player__mark${group.named ? '' : ' player__mark--unnamed'}${merged ? ' player__mark--merged' : ''}`);
      el.style.left = `${group.leftPct}%`;
      el.style.width = `${group.widthPct}%`;
      el.dataset.noteIds = group.notes.map((note) => note.id).join(' ');
      el.title = merged ? `${group.notes.length} notes here · zoom or use the list` : group.notes[0].label;
      el.addEventListener('click', (event) => {
        // A mark is a seek target, not part of the track behind it.
        event.stopPropagation();
        // A merged mark cannot know which note was meant, so it opens them in
        // the list instead of guessing (f20); a lone mark just plays.
        if (merged && this.revealNotes(group.notes.map((note) => note.id))) return;
        this.callbacks.seekTo(group.notes[0].startMs);
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
    this.positionMs = positionMs;
    this.syncTranscript(positionMs);
  }

  /**
   * The rail (f10): a header with the note count and SRT, then the transcript,
   * each run of lines said during a note under that note's sticky heading. In
   * fullscreen (f15) the header also names itself and carries its own hide
   * button, since the popup header that held the toggle is gone.
   */
  private buildRail(): void {
    this.rail.hidden = true;
    this.rail.setAttribute('aria-label', 'Transcript');
    const head = $('div', 'player__rail-head');
    const label = $('span', 'player__rail-label');
    const name = $('span', 'player__rail-name'); name.textContent = 'TRANSCRIPT';
    label.append(name, this.railCount);
    const srt = document.createElement('button');
    srt.className = 'player__rail-srt'; srt.type = 'button';
    srt.title = 'Download subtitles · .srt';
    srt.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 1.6v6.2M3.6 5.6L6 8l2.4-2.4M2.2 10.2h7.6"/></svg>';
    srt.append('SRT');
    srt.addEventListener('click', () => this.downloadSrt());
    const hide = document.createElement('button');
    hide.className = 'player__rail-hide'; hide.type = 'button';
    hide.title = 'Hide the transcript'; hide.setAttribute('aria-label', 'Hide the transcript');
    hide.innerHTML = RAIL_ICON;
    hide.addEventListener('click', () => this.setRailOpen(false));
    head.append(label, srt, hide);

    // Search (f20): only a long rail gets it, see RAIL_INDEX_NOTES.
    this.railSearch.hidden = true;
    const field = $('label', 'player__rail-search-field');
    field.insertAdjacentHTML('afterbegin', SEARCH_ICON);
    this.railQuery.className = 'player__rail-query';
    this.railQuery.type = 'search';
    this.railQuery.placeholder = 'Search notes and lines';
    this.railQuery.setAttribute('aria-label', 'Search notes and lines');
    this.railQuery.addEventListener('input', () => this.applyQuery(this.railQuery.value));
    this.railQuery.addEventListener('keydown', (event) => {
      // Escape clears first and only then leaves the field; it never closes the player from here.
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (this.railQuery.value) { this.railQuery.value = ''; this.applyQuery(''); } else this.railQuery.blur();
    });
    field.append(this.railQuery);
    this.railSearch.append(field);
    this.railEmpty.hidden = true;

    // Only a person scrolling pauses the follow; the rail's own scrolls do not.
    const userScroll = () => { if (!this.programmaticScroll) this.userScrolledAt = Date.now(); };
    this.railList.addEventListener('wheel', userScroll, { passive: true });
    this.railList.addEventListener('scroll', userScroll, { passive: true });
    this.rail.append(head, this.railSearch, this.railList);
  }

  /** Gives the player its transcript, or leaves the rail absent (null or empty). */
  setTranscript(segments: TranscriptSegment[] | null, notations: RecordingNotation[], title: string): void {
    this.segments = segments?.length ? sortSegments(segments) : [];
    this.notations = notations;
    this.transcriptTitle = title || 'transcript';
    this.activeIndex = -1;
    this.lineElements = [];
    this.railEntries = [];
    this.headings.clear();
    this.renamingId = null;
    this.railList.replaceChildren();
    const present = this.segments.length > 0;
    this.railToggle.hidden = !present;
    this.subtitle.hidden = true;
    if (!present) {
      this.rail.hidden = true;
      this.pictureRailButton.hidden = true;
      this.body.classList.remove('player__body--rail');
      return;
    }
    this.railCount.textContent = notations.length
      ? `${notations.length} ${notations.length === 1 ? 'NOTE' : 'NOTES'}`
      : 'TRANSCRIPT';
    this.rail.classList.toggle('player__rail--counted', notations.length > 0);
    const indexed = notations.length >= RAIL_INDEX_NOTES;
    this.railSearch.hidden = !indexed;
    this.railQuery.value = '';
    this.query = '';
    for (const item of railItems(this.segments, notations)) {
      if (item.kind === 'heading') {
        const heading = this.heading(item.notation, indexed);
        this.railList.append(heading);
        this.headings.set(item.notation.id, heading);
        this.railEntries.push({ element: heading, kind: 'heading', noteId: item.notation.id, text: item.notation.text.toLowerCase() });
        continue;
      }
      const line = document.createElement('button');
      line.type = 'button';
      line.className = `player__rail-line${item.noteId ? ' player__rail-line--noted' : ''}`;
      const gutter = $('span', `player__rail-gutter${item.edge ? ` player__rail-gutter--${item.edge}` : ''}`);
      const content = $('span', 'player__rail-content');
      const meta = $('span', 'player__rail-meta');
      const time = $('span', 'player__rail-time'); time.textContent = formatClock(item.segment.tStartMs);
      meta.append(time);
      if (item.segment.speaker) {
        const tag = $('span', 'player__rail-tag');
        tag.textContent = item.segment.speaker.length > 18 ? `${item.segment.speaker.slice(0, 17)}…` : item.segment.speaker;
        tag.title = item.segment.speaker;
        meta.append(tag);
      }
      const text = $('span', 'player__rail-text'); text.textContent = item.segment.text;
      content.append(meta, text);
      line.append(gutter, content);
      line.addEventListener('click', () => this.callbacks.seekTo(item.segment.tStartMs));
      this.railList.append(line);
      this.lineElements[item.index] = line;
      this.railEntries.push({
        element: line,
        kind: 'line',
        noteId: item.noteId,
        text: `${item.segment.speaker ?? ''} ${item.segment.text}`.toLowerCase(),
      });
    }
    this.railList.append(this.railEmpty);
    this.setRailOpen(this.railOpen);
    this.syncTranscript(this.positionMs);
  }

  /**
   * A note's sticky heading. The row plays from the note; its name and the
   * pencil that hovering reveals rename it in place (f18). A long rail adds the
   * start time on the right, so the headings read as a contents page (f20).
   */
  private heading(notation: RecordingNotation, indexed: boolean): HTMLElement {
    const heading = $('div', `player__rail-heading${notation.text ? '' : ' player__rail-heading--unnamed'}`);
    heading.title = 'Play from the start of this note';
    heading.tabIndex = 0;
    heading.dataset.noteId = notation.id;
    const play = () => this.callbacks.seekTo(notation.tStartMs);
    heading.addEventListener('click', play);
    heading.addEventListener('keydown', (event) => {
      if (event.target === heading && event.key === 'Enter') { event.preventDefault(); play(); }
    });
    this.paintHeading(heading, notation, indexed);
    return heading;
  }

  private paintHeading(heading: HTMLElement, notation: RecordingNotation, indexed = this.railSearch.hidden === false): void {
    heading.classList.remove('player__rail-heading--editing');
    heading.classList.toggle('player__rail-heading--unnamed', !notation.text);
    heading.tabIndex = 0;
    const name = $('span', 'player__rail-heading-name');
    name.textContent = notation.text || 'Unnamed';
    heading.replaceChildren(name);
    if (this.callbacks.renameNote) {
      const rename = (event: Event) => { event.stopPropagation(); this.beginRename(notation.id); };
      name.addEventListener('click', rename);
      const pencil = document.createElement('button');
      pencil.type = 'button';
      pencil.className = 'player__rail-rename';
      pencil.title = 'Rename this note'; pencil.setAttribute('aria-label', 'Rename this note');
      pencil.innerHTML = PENCIL_ICON;
      pencil.addEventListener('click', rename);
      heading.append(pencil);
    }
    if (indexed) {
      const time = $('span', 'player__rail-heading-time');
      time.textContent = formatClock(notation.tStartMs);
      heading.append(time);
    }
  }

  /**
   * Turns a heading into its name field (f18): Enter or the tick keeps the
   * name, Escape puts the old one back. The mark keeps its place throughout,
   * since a name never touches the timing.
   */
  beginRename(id: string): boolean {
    const heading = this.headings.get(id);
    const notation = this.notations.find((candidate) => candidate.id === id);
    if (!heading || !notation || !this.callbacks.renameNote) return false;
    if (this.renamingId && this.renamingId !== id) {
      const open = this.headings.get(this.renamingId);
      const openNote = this.notations.find((candidate) => candidate.id === this.renamingId);
      if (open && openNote) this.paintHeading(open, openNote);
    }
    this.renamingId = id;
    heading.classList.add('player__rail-heading--editing');
    heading.removeAttribute('tabindex');
    const field = $('span', 'player__rail-rename-field');
    const input = document.createElement('input');
    input.className = 'player__rail-rename-input';
    input.value = notation.text;
    input.placeholder = 'Name this note';
    input.setAttribute('aria-label', 'Note name');
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'player__rail-rename-save';
    save.title = 'Save'; save.setAttribute('aria-label', 'Save the name');
    save.innerHTML = TICK_ICON;
    field.append(input, save);
    heading.replaceChildren(field);

    let settled = false;
    const finish = (keep: boolean) => {
      if (settled) return;
      settled = true;
      void this.finishRename(notation, keep ? input.value.trim() : notation.text);
    };
    field.addEventListener('click', (event) => event.stopPropagation());
    // Pressing the tick blurs the field first; mousedown keeps focus so the
    // click, not the blur, is what saves.
    save.addEventListener('mousedown', (event) => event.preventDefault());
    save.addEventListener('click', () => finish(true));
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    if (!this.rail.hidden) {
      this.programmaticScroll = true;
      heading.scrollIntoView?.({ block: 'nearest' });
      requestAnimationFrame(() => { this.programmaticScroll = false; });
    }
    input.focus();
    input.select();
    return true;
  }

  private async finishRename(notation: RecordingNotation, text: string): Promise<void> {
    const heading = this.headings.get(notation.id);
    if (this.renamingId === notation.id) this.renamingId = null;
    if (!heading) return;
    const previous = notation.text;
    if (text === previous) { this.paintHeading(heading, notation); heading.focus({ preventScroll: true }); return; }
    // Shown at once and put back if the write fails: the name is the user's,
    // and waiting on the background would make the field feel stuck.
    this.applyNoteName(notation.id, text);
    heading.focus({ preventScroll: true });
    const saved = await this.callbacks.renameNote?.(notation.id, text);
    if (saved === false) this.applyNoteName(notation.id, previous);
  }

  /** One note's name, everywhere the player shows it: its heading, its mark, the search. */
  private applyNoteName(id: string, text: string): void {
    this.notations = this.notations.map((note) => (note.id === id ? { ...note, text } : note));
    const notation = this.notations.find((note) => note.id === id);
    const heading = this.headings.get(id);
    if (notation && heading && this.renamingId !== id) this.paintHeading(heading, notation);
    const entry = this.railEntries.find((candidate) => candidate.kind === 'heading' && candidate.noteId === id);
    if (entry) entry.text = text.toLowerCase();
    for (const mark of Array.from(this.marks.querySelectorAll<HTMLElement>('.player__mark'))) {
      const ids = mark.dataset.noteIds?.split(' ') ?? [];
      if (ids.length !== 1 || ids[0] !== id) continue;
      mark.title = text || 'Name this one';
      mark.classList.toggle('player__mark--unnamed', !text);
    }
  }

  /** `R`: renames the note under the playhead, opening the rail to do it. */
  renameNoteAt(positionMs: number): boolean {
    const notation = noteAt(this.notations, positionMs);
    if (!notation || !this.headings.has(notation.id)) return false;
    if (!this.railOpen) this.setRailOpen(true);
    return this.beginRename(notation.id);
  }

  /** `/`: into the rail's search, when the rail is long enough to have one. */
  focusSearch(): boolean {
    if (!this.segments.length || this.railSearch.hidden) return false;
    if (!this.railOpen) this.setRailOpen(true);
    this.railQuery.focus();
    this.railQuery.select();
    return true;
  }

  /** A merged mark's notes, brought into view in the rail (f20). False when there is no rail to show them in. */
  private revealNotes(ids: string[]): boolean {
    const first = ids.map((id) => this.headings.get(id)).find(Boolean);
    if (!first) return false;
    if (!this.railOpen) this.setRailOpen(true);
    if (this.query) { this.railQuery.value = ''; this.applyQuery(''); }
    this.userScrolledAt = Date.now();
    this.programmaticScroll = true;
    first.scrollIntoView?.({ block: 'start' });
    requestAnimationFrame(() => { this.programmaticScroll = false; });
    for (const id of ids) {
      const heading = this.headings.get(id);
      if (!heading) continue;
      heading.classList.remove('player__rail-heading--revealed');
      // Restarted rather than toggled, so a second click flashes again.
      void heading.offsetWidth;
      heading.classList.add('player__rail-heading--revealed');
    }
    return true;
  }

  /**
   * Filters the rail to what matches (f20): a line by its words or speaker, a
   * heading by its name. A matching heading keeps its lines, and a matching line
   * keeps its heading, so every hit still says which note it sits in.
   */
  private applyQuery(value: string): void {
    this.query = value.trim().toLowerCase();
    const query = this.query;
    const headingHit = new Set<string>();
    const lineHit = new Set<string>();
    for (const entry of this.railEntries) {
      if (!query || !entry.text.includes(query) || !entry.noteId) continue;
      (entry.kind === 'heading' ? headingHit : lineHit).add(entry.noteId);
    }
    let shown = 0;
    for (const entry of this.railEntries) {
      const visible = !query
        || entry.text.includes(query)
        || (entry.noteId != null && (entry.kind === 'heading' ? lineHit.has(entry.noteId) : headingHit.has(entry.noteId)));
      entry.element.hidden = !visible;
      if (visible && entry.kind === 'line') shown += 1;
    }
    this.railEmpty.hidden = !query || shown > 0 || this.railEntries.some((entry) => entry.kind === 'heading' && !entry.element.hidden);
    this.railEmpty.textContent = `NOTHING MATCHES “${value.trim().toUpperCase()}”`;
    if (!query) this.syncTranscript(this.positionMs, true);
  }

  private setRailOpen(open: boolean): void {
    this.railOpen = open;
    const present = this.segments.length > 0;
    this.rail.hidden = !present || !open;
    this.pictureRailButton.hidden = !present || open;
    this.body.classList.toggle('player__body--rail', present && open);
    this.railToggle.classList.toggle('player__rail-toggle--open', open);
    this.railToggle.setAttribute('aria-pressed', String(open));
    this.railToggle.title = open ? 'Hide transcript' : 'Show transcript';
    this.railToggle.setAttribute('aria-label', this.railToggle.title);
  }

  /** Swaps the fullscreen button between entering and leaving (f15). */
  setFullscreen(on: boolean): void {
    this.fullscreenButton.title = on ? 'Leave fullscreen' : 'Fullscreen';
    this.fullscreenButton.setAttribute('aria-label', this.fullscreenButton.title);
    this.fullscreenButton.innerHTML = on ? LEAVE_FULLSCREEN_ICON : ENTER_FULLSCREEN_ICON;
  }

  /** The `C` key and the Subtitles row: the band on the picture, not the rail. */
  toggleSubtitles(): boolean {
    if (!this.segments.length) return false;
    this.setSubtitles(!this.subtitlesOn);
    return true;
  }

  private setSubtitles(on: boolean): void {
    this.subtitlesOn = on;
    this.paintSubtitle();
  }

  /** Keeps the playing line and the subtitle in step; touches the DOM only on a change. */
  private syncTranscript(positionMs: number, force = false): void {
    if (!this.segments.length) return;
    const index = activeSegmentIndex(this.segments, positionMs);
    if (index === this.activeIndex && !force) return;
    this.lineElements[this.activeIndex]?.classList.remove('player__rail-line--active');
    this.activeIndex = index;
    const line = this.lineElements[index];
    line?.classList.add('player__rail-line--active');
    this.paintSubtitle();
    // Follow the conversation, unless the user is reading elsewhere in it,
    // searching it, or naming a note in it.
    if (line && !line.hidden && !this.rail.hidden && !this.query && !this.renamingId && Date.now() - this.userScrolledAt > 4000) {
      this.programmaticScroll = true;
      line.scrollIntoView?.({ block: 'nearest' });
      requestAnimationFrame(() => { this.programmaticScroll = false; });
    }
  }

  private paintSubtitle(): void {
    const segment = this.segments[this.activeIndex];
    this.subtitle.hidden = !this.subtitlesOn || !segment;
    if (!segment) return;
    const bubble = $('span', 'player__subtitle-bubble');
    if (segment.speaker) {
      const tag = $('span', 'player__subtitle-tag');
      tag.textContent = segment.speaker;
      bubble.append(tag);
    }
    bubble.append(segment.text);
    this.subtitle.replaceChildren(bubble);
  }

  private downloadSrt(): void {
    const url = URL.createObjectURL(new Blob([toSrt(this.segments)], { type: 'application/x-subrip' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.transcriptTitle.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'transcript'}.srt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
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

  /**
   * The recording is unreachable, not merely paused: the frame goes quiet and
   * says why, while the controls stay in place so the view keeps its shape (f16).
   */
  setStatus(status: PlayerStatus | null): void {
    this.status.replaceChildren();
    this.status.hidden = !status;
    this.stage.classList.toggle('player__stage--quiet', Boolean(status));
    if (!status) return;
    const icon = $('span', 'player__status-icon');
    icon.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.4"/><path d="M10 6.4v4.4M10 13.6v.5"/></svg>';
    const copy = $('span', 'player__status-copy');
    const title = $('span', 'player__status-title'); title.textContent = status.title;
    copy.append(title);
    if (status.body) { const body = $('span', 'player__status-body'); body.textContent = status.body; copy.append(body); }
    this.status.append(icon, copy);
    const actions = (status.actions ?? []).filter((action) => (action === 'folder' ? this.callbacks.openFolder : this.callbacks.remove));
    if (actions.length) {
      const row = $('span', 'player__status-actions');
      for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `player__status-action${action === 'remove' ? ' player__status-action--danger' : ''}`;
        button.textContent = action === 'folder' ? 'Open the folder' : 'Remove from history';
        button.addEventListener('click', () => (action === 'folder' ? this.callbacks.openFolder?.() : this.callbacks.remove?.()));
        row.append(button);
      }
      this.status.append(row);
    }
    this.clock.textContent = `— / ${formatClock(this.durationMs)}`;
  }
}
