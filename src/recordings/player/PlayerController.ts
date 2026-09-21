/**
 * @file recordings/player/PlayerController.ts
 *
 * Opens a recording in the player: fetch the manifest, resolve the master
 * track to something playable, and drive the element.
 *
 * The controller never handles media bytes. For OPFS it hands the element an
 * object URL; for Drive it asks background to authorize this tab and hands the
 * element a URL — the token stays in the worker either way.
 */

import { isStreamableSource, masterTrack, type PlaybackManifest, type PlaybackTrack } from '../../shared/playback';
import type { RecordingNotation } from '../../shared/notations';
import type { Transcript } from '../../shared/transcript';
import { playbackUrl, type SourceResolverDeps } from './playbackSource';
import { PlayerView, type PlayerStatus } from './PlayerView';
import { PlaybackClock } from './PlaybackClock';
import { adjacentMarkStart, isFieldTarget, nextSpeed, resolvePlayerAction, type PlayerAction } from './playerKeymap';
import { clockOffsetMs, describeTracks, toggleShown } from './playerTracks';

/** What survives an unreachable video, said on every such status (f16). */
const KEPT = 'Notes and transcript are kept by the extension and are still available.';
const DRIVE_UNREACHABLE: PlayerStatus = {
  title: 'Could not open this recording from Google Drive.',
  body: `It was deleted or moved, or Drive could not be reached. ${KEPT}`,
  actions: ['folder', 'remove'],
};
const UNPLAYABLE: PlayerStatus = {
  title: 'This recording could not be played.',
  body: 'The file is there, but this browser could not decode it.',
};

export type PlayerControllerDeps = {
  getManifest: (recordingId: string) => Promise<PlaybackManifest | undefined>;
  /** Extension-only. A remote-only web viewer does not need Drive authorization. */
  prepareDriveSource?: (recordingId: string, fileId: string, refresh?: boolean) => Promise<string | undefined>;
  openDownloaded?: (recordingId: string, fileId: string) => void;
  /** Opens the recording's Drive folder, when it has one (f16). */
  openFolder?: (recordingId: string) => void;
  /** Takes the recording out of history, after the page's own confirmation (f16). */
  remove?: (recordingId: string) => void;
  /** The recording's persisted transcript (ADR-0007), for the rail and the subtitles (f10). */
  getTranscript?: (recordingId: string) => Promise<Transcript | undefined>;
  /** Renames a note from its rail heading (f18); the same write the details dialog makes. */
  renameNotation?: (recordingId: string, id: string, text: string) => Promise<RecordingNotation[] | void>;
  resolver?: SourceResolverDeps;
  warn?: (...args: unknown[]) => void;
};

export class PlayerController {
  private readonly view: PlayerView;
  private revoke: (() => void) | null = null;
  /** One per attached auxiliary; an unrevoked URL pins its OPFS file. */
  private auxRevokes: Array<() => void> = [];
  private clock: PlaybackClock | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onKeyDown = (event: KeyboardEvent) => this.handleKey(event);
  private readonly onFullscreenChange = () => this.view.setFullscreen(document.fullscreenElement === this.view.overlay);
  /** Which files are switched on; the rest stay listed but silent and hidden. */
  private shown = new Set<string>();
  private readonly levels = new Map<string, number>();
  private readonly muted = new Set<string>();
  private readonly elements = new Map<string, HTMLMediaElement>();
  /** File ids that really got a source; everything else is reported unavailable. */
  private readonly attached = new Set<string>();
  private skipSeconds = 10;
  private speed = 1;
  private manifest: PlaybackManifest | null = null;
  private track: PlaybackTrack | null = null;
  /** One recovery attempt per open — see `onMediaError`. */
  private refreshed = false;

  constructor(private readonly deps: PlayerControllerDeps) {
    this.view = new PlayerView({
      close: () => this.close(),
      ...(deps.openFolder ? { openFolder: () => { if (this.manifest) deps.openFolder?.(this.manifest.recordingId); } } : {}),
      ...(deps.remove ? { remove: () => { if (this.manifest) deps.remove?.(this.manifest.recordingId); } } : {}),
      seekTo: (ms) => this.seek(ms),
      togglePlay: () => { void this.togglePlay(); },
      toggleFullscreen: () => { void this.toggleFullscreen(); },
      toggleFile: (fileId) => { this.shown = toggleShown(this.shown, fileId); this.applyTrackState(); },
      setVolume: (fileId, level) => {
        this.levels.set(fileId, level);
        // Moving a muted fader is an unmute — otherwise nothing appears to happen.
        if (level > 0) this.muted.delete(fileId);
        // Elements and readout only: rebuilding the menu here would replace the
        // fader the pointer is holding.
        this.applyLevels();
        this.view.updateFader(fileId, level, this.muted.has(fileId));
      },
      toggleTrackMuted: (fileId) => {
        if (!this.muted.delete(fileId)) this.muted.add(fileId);
        this.applyLevels();
        this.view.updateFader(fileId, this.levels.get(fileId) ?? 1, this.muted.has(fileId));
      },
      setSkipSeconds: (seconds) => { this.skipSeconds = seconds; this.view.setSettings(this.skipSeconds, this.speed); },
      setSpeed: (rate) => this.applySpeed(rate),
      ...(deps.renameNotation ? { renameNote: (id: string, text: string) => this.renameNote(id, text) } : {}),
    });
    this.bindMedia();
    // Bound on the document rather than the dialog: the shortcuts should work
    // wherever focus happens to sit inside the modal.
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
  }

  /** Writes a note's new name, and keeps the manifest in step when it lands. */
  private async renameNote(id: string, text: string): Promise<boolean> {
    const manifest = this.manifest;
    if (!manifest || !this.deps.renameNotation) return false;
    try {
      await this.deps.renameNotation(manifest.recordingId, id, text);
    } catch (error) {
      this.deps.warn?.('Could not rename the note', error);
      return false;
    }
    if (this.manifest === manifest) {
      this.manifest = { ...manifest, notations: manifest.notations.map((note) => (note.id === id ? { ...note, text } : note)) };
    }
    return true;
  }

  private handleKey(event: KeyboardEvent): void {
    const action = resolvePlayerAction(event, {
      inField: isFieldTarget(event.target),
      skipSeconds: this.skipSeconds,
    });
    if (!action) return;
    event.preventDefault();
    void this.dispatch(action);
  }

  private async dispatch(action: PlayerAction): Promise<void> {
    const video = this.view.video;
    switch (action.kind) {
      case 'play-pause': return void this.togglePlay();
      case 'skip': return this.seek((video.currentTime + action.seconds) * 1000);
      case 'speed': return this.applySpeed(nextSpeed(this.speed, action.direction));
      case 'volume': {
        // Rides the master; per-track levels are what the faders are for.
        if (!this.track) return;
        const current = this.levels.get(this.track.fileId) ?? 1;
        this.levels.set(this.track.fileId, Math.min(1, Math.max(0, current + action.direction * 0.1)));
        this.muted.delete(this.track.fileId);
        this.applyTrackState();
        return;
      }
      case 'mute': {
        // Mutes every audio track at once, through the same state the faders use.
        const anyAudible = [...this.elements.keys()].some((id) => !this.muted.has(id));
        for (const fileId of this.elements.keys()) {
          if (anyAudible) this.muted.add(fileId);
          else this.muted.delete(fileId);
        }
        this.applyTrackState();
        return;
      }
      case 'note': {
        const starts = (this.manifest?.notations ?? []).map((note) => note.tStartMs);
        const target = adjacentMarkStart(starts, video.currentTime * 1000, action.direction);
        if (target != null) this.seek(target);
        return;
      }
      case 'topic': {
        // Every span's start, not one per topic: walking by subject means
        // stopping where the conversation *returned* to one, too (MODEL-04).
        const starts = (this.manifest?.topics ?? [])
          .flatMap((topic) => topic.spans.map((span) => span.tStartMs));
        const target = adjacentMarkStart(starts, video.currentTime * 1000, action.direction);
        if (target != null) this.seek(target);
        return;
      }
      case 'fullscreen': return void this.toggleFullscreen();
      case 'subtitles': {
        if (this.view.toggleSubtitles()) this.view.setSettings(this.skipSeconds, this.speed);
        return;
      }
      case 'transcript': { this.view.toggleRail(); return; }
      case 'rename': { this.view.renameNoteAt(video.currentTime * 1000); return; }
      case 'search': { this.view.focusSearch(); return; }
      case 'help': { this.view.toggleHelp(); return; }
      case 'escape': {
        // Escape unwinds one layer at a time: the map, then fullscreen, then the
        // player itself. Closing outright would lose the user's place.
        if (this.view.helpOpen) { this.view.toggleHelp(false); return; }
        if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); return; }
        this.close();
        return;
      }
    }
  }

  private applySpeed(rate: number): void {
    this.speed = rate;
    if (this.clock) this.clock.setPlaybackRate(rate);
    else this.view.video.playbackRate = rate;
    this.view.setSettings(this.skipSeconds, this.speed);
  }

  private seek(ms: number): void {
    if (this.clock) this.clock.seek(ms);
    else this.view.video.currentTime = Math.max(0, ms / 1000);
  }

  get element(): HTMLElement { return this.view.overlay; }

  /**
   * The rail and the subtitles, when the recording has a transcript. Loaded
   * beside playback rather than before it: a failure here costs the rail, never
   * the video, and says nothing on the picture.
   */
  private async loadTranscript(manifest: PlaybackManifest): Promise<void> {
    this.view.setTranscript(null, [], manifest.title);
    if (manifest.transcriptStatus !== 'ready' || !this.deps.getTranscript) return;
    let transcript: Transcript | undefined;
    try {
      transcript = await this.deps.getTranscript(manifest.recordingId);
    } catch (error) {
      this.deps.warn?.('Could not read the transcript', error);
      return;
    }
    // The player may have closed or moved on while the transcript was read.
    if (this.manifest !== manifest || !transcript?.segments.length) return;
    this.view.setTranscript(transcript.segments, manifest.notations, manifest.title);
    this.view.setSettings(this.skipSeconds, this.speed);
  }

  async open(recordingId: string): Promise<void> {
    this.reset();
    const manifest = await this.deps.getManifest(recordingId);
    if (!manifest) { this.view.setStatus({ title: 'This recording is no longer available.' }); return; }
    this.manifest = manifest;
    this.view.render(manifest);
    void this.loadTranscript(manifest);

    const track = masterTrack(manifest);
    if (!track) {
      // Legacy local recordings: only a Downloads copy remains, and
      // chrome.downloads exposes no bytes to us.
      const external = manifest.tracks.flatMap((t) => t.sources).find((s) => s.kind === 'download');
      this.view.setStatus(external
        ? { title: 'This recording was saved before in-extension playback.', body: 'Open the downloaded file instead.' }
        : { title: 'This recording has no playable copy left.', body: KEPT, actions: ['remove'] });
      return;
    }
    this.track = track;
    // Deliberately logged: when playback misbehaves for a recording we cannot
    // reproduce, this one line says what the manifest actually held.
    console.debug('[player] tracks', manifest.tracks.map((t) =>
      `${t.stream}|${t.mimeType}|${t.sources.map((s) => s.kind).join('+') || 'none'}`).join('  '));
    this.elements.set(track.fileId, this.view.video);
    this.shown = new Set(manifest.tracks.map((candidate) => candidate.fileId));
    await this.attach(track);
    await this.attachAuxiliaries(manifest, track);
    this.applyTrackState();
    this.view.setSettings(this.skipSeconds, this.speed);

    // Opening a recording is an explicit request to watch it, and the click that
    // opened the player is the gesture that lets audio start.
    if (this.attached.size) await this.togglePlay().catch(() => {});
  }

  /**
   * Pushes visibility, level and mute onto the elements, then re-renders the
   * menus from the same state so the trigger count and the checkboxes cannot
   * disagree with what is actually playing.
   */
  /** Pushes level and mute onto the elements. Renders nothing. */
  private applyLevels(): void {
    for (const [fileId, element] of this.elements) {
      const on = this.shown.has(fileId);
      const isCamera = element !== this.view.video && element.tagName === 'VIDEO';
      element.volume = this.levels.get(fileId) ?? 1;
      element.muted = !on || this.muted.has(fileId) || isCamera;
    }
  }

  private applyTrackState(): void {
    for (const [fileId, element] of this.elements) {
      const on = this.shown.has(fileId);
      const isCamera = element !== this.view.video && element.tagName === 'VIDEO';
      element.volume = this.levels.get(fileId) ?? 1;
      // The camera never carries audio, so it stays muted whatever the user does.
      element.muted = !on || this.muted.has(fileId) || isCamera;
      if (isCamera) element.hidden = !on;
      if (element === this.view.video) this.view.video.classList.toggle('player__video--hidden', !on);
    }
    if (this.manifest) {
      this.view.setTracks(describeTracks(this.manifest, this.shown, this.attached), this.levels, this.muted);
    }
  }

  private async togglePlay(): Promise<void> {
    const playing = !this.view.video.paused;
    if (!this.clock) {
      await (playing ? this.view.video.pause() : this.view.video.play().catch(() => {}));
      return;
    }
    if (playing) this.clock.pause();
    else await this.clock.play().catch(() => {});
  }

  /**
   * Attaches mic and camera tracks and puts them on the master's clock. A track
   * that cannot be resolved is skipped rather than failing playback: hearing the
   * meeting without the camera beats not watching it at all.
   */
  private async attachAuxiliaries(manifest: PlaybackManifest, master: PlaybackTrack): Promise<void> {
    const clock = new PlaybackClock(this.view.video, {
      onDrift: (seconds) => this.deps.warn?.(`Auxiliary track drifted ${(seconds * 1000).toFixed(0)}ms`),
    });
    for (const track of manifest.tracks) {
      if (track.fileId === master.fileId) continue;
      const resolved = await this.urlFor(track);
      if (!resolved) {
        // Better to watch the meeting without the camera than not at all.
        this.deps.warn?.(`No playable source for the ${track.stream} track`);
        continue;
      }
      // A dedicated element per track: sharing one meant a second audio track
      // silently replaced the first, and only the last was ever heard.
      // Keyed on the stream, not the mime type: `contentTypeForRecordingFilename`
      // maps every `.webm` to `video/webm`, so a microphone file claims to be
      // video and would render a second picture-in-picture.
      const element = this.view.addAuxiliary(track.stream === 'self-video' ? 'video' : 'audio');
      if (resolved.revoke) this.auxRevokes.push(resolved.revoke);
      element.src = resolved.url;
      this.elements.set(track.fileId, element);
      this.attached.add(track.fileId);
      clock.add({ element, timelineOffsetMs: clockOffsetMs(track, master) });
    }
    this.clock = clock;
  }

  /**
   * Resolves one track to a URL a media element can take. Shared by the master
   * and every auxiliary, so a Drive recording gets a lease per track rather
   * than playing its picture alone.
   */
  private async urlFor(track: PlaybackTrack, refresh = false): Promise<{ url: string; revoke?: () => void } | undefined> {
    if (!this.manifest) return undefined;
    return playbackUrl(this.manifest.recordingId, track, this.deps, refresh);
  }

  private async attach(track: PlaybackTrack, refresh = false): Promise<void> {
    const resolved = await this.urlFor(track, refresh);
    if (!resolved) {
      this.view.setStatus(track.sources.some((source) => source.kind === 'drive')
        ? DRIVE_UNREACHABLE
        : { title: 'This recording has no playable copy left.', body: KEPT, actions: ['remove'] });
      return;
    }
    this.revoke = resolved.revoke ?? null;
    this.view.setStatus(null);
    this.view.video.src = resolved.url;
    this.attached.add(track.fileId);
  }

  private bindMedia(): void {
    const video = this.view.video;
    video.addEventListener('loadedmetadata', () => {
      // A recording whose duration history never recorded still needs a scrubber.
      if (Number.isFinite(video.duration)) this.view.setPosition(video.currentTime * 1000, video.duration * 1000);
    });
    video.addEventListener('timeupdate', () => this.view.setPosition(video.currentTime * 1000));
    video.addEventListener('play', () => { this.view.setPlaying(true); this.startDriftWatch(); });
    video.addEventListener('pause', () => { this.view.setPlaying(false); this.stopDriftWatch(); });
    video.addEventListener('error', () => { void this.onMediaError(); });
  }

  /**
   * A Drive access token is short-lived, so the first media error on a Drive
   * source is assumed to be expiry: re-mint once, reinstall the rule and reload
   * from the same position. Exactly once — a retry loop against a genuinely
   * missing file would hammer Drive.
   */
  private async onMediaError(): Promise<void> {
    if (!this.track || this.refreshed) {
      this.view.setStatus(UNPLAYABLE);
      return;
    }
    if (!this.track.sources.some((source) => source.kind === 'drive')) {
      this.view.setStatus(UNPLAYABLE);
      return;
    }
    this.refreshed = true;
    const position = this.view.video.currentTime;
    await this.attach(this.track, true);
    if (this.view.video.src) this.view.video.currentTime = position;
  }

  /** A few times a second is enough: drift accrues slowly (ADR-0006 §21). */
  private startDriftWatch(): void {
    if (this.driftTimer || !this.clock) return;
    this.driftTimer = setInterval(() => this.clock?.correctDrift(), 400);
  }

  private stopDriftWatch(): void {
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.driftTimer = null;
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await this.view.overlay.requestFullscreen?.();
    } catch (error) {
      this.deps.warn?.('Fullscreen was refused', error);
    }
  }

  close(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    this.reset();
    this.element.remove();
  }

  private reset(): void {
    this.stopDriftWatch();
    this.clock?.clear();
    this.clock = null;
    this.view.video.pause();
    this.view.video.removeAttribute('src');
    this.view.video.load();
    this.view.clearAuxiliaries();
    this.view.closePopovers();
    this.view.toggleHelp(false);
    this.skipSeconds = 10;
    this.speed = 1;
    this.elements.clear();
    this.levels.clear();
    this.muted.clear();
    this.attached.clear();
    this.shown = new Set();
    // Object URLs pin the underlying OPFS file; leaking them leaks the file.
    this.revoke?.();
    this.revoke = null;
    for (const revoke of this.auxRevokes) revoke();
    this.auxRevokes = [];
    this.manifest = null;
    this.track = null;
    this.refreshed = false;
    this.view.setStatus(null);
  }
}

/** True when a manifest has something the extension can actually stream. */
export function hasStreamableTrack(manifest: PlaybackManifest): boolean {
  return manifest.tracks.some((track) => track.sources.some(isStreamableSource));
}
