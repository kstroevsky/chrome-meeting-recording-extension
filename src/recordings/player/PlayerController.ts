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
  private manifest: PlaybackManifest | null = null;
  private track: PlaybackTrack | null = null;
  /** One recovery attempt per open — see `onMediaError`. */
  private refreshed = false;

  constructor(private readonly deps: PlayerControllerDeps) {
    this.view = new PlayerView({
      close: () => this.close(),
      seekTo: (ms) => { this.view.video.currentTime = ms / 1000; },
      togglePlay: () => { void (this.view.video.paused ? this.view.video.play().catch(() => {}) : this.view.video.pause()); },
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
  }

  private async attach(track: PlaybackTrack, refresh = false): Promise<void> {
    const drive = track.sources.find((source) => source.kind === 'drive');
    const preferOpfs = track.sources.find((source) => source.kind === 'opfs');

    if (preferOpfs && !refresh) {
      const resolved = await resolveTrackSource(track, this.deps.resolver);
      if (resolved.kind === 'opfs') {
        this.revoke = resolved.revoke;
        this.view.setStatus(null);
        this.view.video.src = resolved.url;
        return;
      }
    }

    if (drive && drive.kind === 'drive' && this.manifest) {
      const url = await this.deps.prepareDriveSource(this.manifest.recordingId, track.fileId, refresh)
        .catch((error) => { this.deps.warn?.('Drive playback preparation failed', error); return undefined; });
      if (url) {
        this.view.setStatus(null);
        this.view.video.src = url;
        return;
      }
      this.view.setStatus('Could not open this recording from Google Drive.');
      return;
    }
    this.view.setStatus('This recording has no playable copy left.');
  }

  private bindMedia(): void {
    const video = this.view.video;
    video.addEventListener('loadedmetadata', () => {
      // A recording whose duration history never recorded still needs a scrubber.
      if (Number.isFinite(video.duration)) this.view.setPosition(video.currentTime * 1000, video.duration * 1000);
    });
    video.addEventListener('timeupdate', () => this.view.setPosition(video.currentTime * 1000));
    video.addEventListener('play', () => this.view.setPlaying(true));
    video.addEventListener('pause', () => this.view.setPlaying(false));
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
    this.view.video.pause();
    this.view.video.removeAttribute('src');
    this.view.video.load();
    // Object URLs pin the underlying OPFS file; leaking them leaks the file.
    this.revoke?.();
    this.revoke = null;
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
