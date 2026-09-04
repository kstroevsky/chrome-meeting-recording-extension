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
import { resolveTrackSource, type SourceResolverDeps } from './playbackSource';
import { PlayerView } from './PlayerView';
import { PlaybackClock } from './PlaybackClock';

export type PlayerControllerDeps = {
  getManifest: (recordingId: string) => Promise<PlaybackManifest | undefined>;
  prepareDriveSource: (recordingId: string, fileId: string, refresh?: boolean) => Promise<string | undefined>;
  openDownloaded?: (recordingId: string, fileId: string) => void;
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
  private manifest: PlaybackManifest | null = null;
  private track: PlaybackTrack | null = null;
  /** One recovery attempt per open — see `onMediaError`. */
  private refreshed = false;

  constructor(private readonly deps: PlayerControllerDeps) {
    this.view = new PlayerView({
      close: () => this.close(),
      seekTo: (ms) => { this.clock ? this.clock.seek(ms) : (this.view.video.currentTime = ms / 1000); },
      togglePlay: () => { void this.togglePlay(); },
      toggleFullscreen: () => { void this.toggleFullscreen(); },
    });
    this.bindMedia();
  }

  get element(): HTMLElement { return this.view.overlay; }

  async open(recordingId: string): Promise<void> {
    this.reset();
    const manifest = await this.deps.getManifest(recordingId);
    if (!manifest) { this.view.setStatus('This recording is no longer available.'); return; }
    this.manifest = manifest;
    this.view.render(manifest);

    const track = masterTrack(manifest);
    if (!track) {
      // Legacy local recordings: only a Downloads copy remains, and
      // chrome.downloads exposes no bytes to us.
      const external = manifest.tracks.flatMap((t) => t.sources).find((s) => s.kind === 'download');
      this.view.setStatus(external
        ? 'This recording was saved before in-extension playback. Open the downloaded file instead.'
        : 'This recording has no playable copy left.');
      return;
    }
    this.track = track;
    await this.attach(track);
    await this.attachAuxiliaries(manifest, track);
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
      const element = track.stream === 'self-video' ? this.view.selfVideo : this.view.micAudio;
      const resolved = await this.urlFor(track);
      if (!resolved) {
        // Better to watch the meeting without the camera than not at all.
        this.deps.warn?.(`No playable source for the ${track.stream} track`);
        continue;
      }
      if (resolved.revoke) this.auxRevokes.push(resolved.revoke);
      element.src = resolved.url;
      if (track.stream === 'self-video') this.view.showSelfCam(true);
      clock.add({ element, timelineOffsetMs: track.timelineOffsetMs });
    }
    this.clock = clock;
  }

  /**
   * Resolves one track to a URL a media element can take. Shared by the master
   * and every auxiliary, so a Drive recording gets a lease per track rather
   * than playing its picture alone.
   */
  private async urlFor(track: PlaybackTrack, refresh = false): Promise<{ url: string; revoke?: () => void } | undefined> {
    if (!refresh && track.sources.some((source) => source.kind === 'opfs')) {
      const resolved = await resolveTrackSource(track, this.deps.resolver);
      if (resolved.kind === 'opfs') return { url: resolved.url, revoke: resolved.revoke };
    }
    if (track.sources.some((source) => source.kind === 'drive') && this.manifest) {
      const url = await this.deps.prepareDriveSource(this.manifest.recordingId, track.fileId, refresh)
        .catch((error) => { this.deps.warn?.('Drive playback preparation failed', error); return undefined; });
      if (url) return { url };
    }
    return undefined;
  }

  private async attach(track: PlaybackTrack, refresh = false): Promise<void> {
    const resolved = await this.urlFor(track, refresh);
    if (!resolved) {
      this.view.setStatus(track.sources.some((source) => source.kind === 'drive')
        ? 'Could not open this recording from Google Drive.'
        : 'This recording has no playable copy left.');
      return;
    }
    this.revoke = resolved.revoke ?? null;
    this.view.setStatus(null);
    this.view.video.src = resolved.url;
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
      this.view.setStatus('This recording could not be played.');
      return;
    }
    if (!this.track.sources.some((source) => source.kind === 'drive')) {
      this.view.setStatus('This recording could not be played.');
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
    this.reset();
    this.element.remove();
  }

  private reset(): void {
    this.stopDriftWatch();
    this.clock?.clear();
    this.clock = null;
    for (const element of [this.view.video, this.view.selfVideo, this.view.micAudio]) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
    this.view.showSelfCam(false);
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
