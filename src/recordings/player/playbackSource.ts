/**
 * @file recordings/player/playbackSource.ts
 *
 * Turns a track's preference-ordered sources into something a media element can
 * take (ADR-0006 §14).
 *
 * OPFS is read here, in the page, not in the background worker: `getFile()`
 * hands back a `File` and `URL.createObjectURL` makes it playable without ever
 * materialising the bytes in JavaScript. A multi-gigabyte recording costs one
 * object URL.
 */

import { readFileByKey, type DirectoryHandleLike } from '../../offscreen/storage/opfsLayout';
import type { PlaybackSource, PlaybackTrack } from '../../shared/playback';

export type ResolvedSource =
  | { kind: 'opfs'; url: string; revoke: () => void }
  /** Sharing service endpoint; authorization is enforced by the server/session. */
  | { kind: 'remote'; url: string }
  /** Drive needs a tab-scoped DNR authorization lease, which does not exist yet. */
  | { kind: 'unsupported'; reason: 'drive-not-wired' }
  /** Only a Downloads copy remains: openable by Chrome, unreadable by us. */
  | { kind: 'external'; downloadId: number }
  | { kind: 'missing' };

export type SourceResolverDeps = {
  getRoot?: () => Promise<DirectoryHandleLike>;
  createObjectURL?: (file: Blob) => string;
  revokeObjectURL?: (url: string) => void;
};

/** What turning a track into a playable URL needs from the page. */
export type PlaybackUrlDeps = {
  prepareDriveSource?: (recordingId: string, fileId: string, refresh?: boolean) => Promise<string | undefined>;
  resolver?: SourceResolverDeps;
  warn?: (...args: unknown[]) => void;
};

/**
 * A URL a media element can load for `track`: the retained copy when there is
 * one, else a prepared Drive stream; undefined when neither can be reached.
 * `refresh` skips the retained copy and re-mints the Drive lease, which is how
 * an expired token is recovered. Shared by the player and the note editor.
 */
export async function playbackUrl(
  recordingId: string,
  track: PlaybackTrack,
  deps: PlaybackUrlDeps,
  refresh = false,
): Promise<{ url: string; revoke?: () => void } | undefined> {
  if (!refresh) {
    const remote = track.sources.find((source) => source.kind === 'remote');
    if (remote) return { url: remote.url };
  }
  if (!refresh && track.sources.some((source) => source.kind === 'opfs')) {
    const resolved = await resolveTrackSource(track, deps.resolver);
    if (resolved.kind === 'opfs') return { url: resolved.url, revoke: resolved.revoke };
  }
  if (deps.prepareDriveSource && track.sources.some((source) => source.kind === 'drive')) {
    const url = await deps.prepareDriveSource(recordingId, track.fileId, refresh)
      .catch((error) => { deps.warn?.('Drive playback preparation failed', error); return undefined; });
    if (url) return { url };
  }
  return undefined;
}

export async function resolveTrackSource(
  track: PlaybackTrack,
  deps: SourceResolverDeps = {},
): Promise<ResolvedSource> {
  const getRoot = deps.getRoot ?? (() => navigator.storage.getDirectory() as unknown as Promise<DirectoryHandleLike>);
  const create = deps.createObjectURL ?? URL.createObjectURL.bind(URL);
  const revokeUrl = deps.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);

  for (const source of track.sources) {
    const resolved = await tryOne(source, getRoot, create, revokeUrl);
    if (resolved) return resolved;
  }
  return { kind: 'missing' };
}

async function tryOne(
  source: PlaybackSource,
  getRoot: () => Promise<DirectoryHandleLike>,
  create: (file: Blob) => string,
  revokeUrl: (url: string) => void,
): Promise<ResolvedSource | undefined> {
  if (source.kind === 'opfs') {
    // A retained file can be gone (deleted, or a stale location the reconciler
    // has not swept yet), so a miss falls through to the next source rather
    // than failing the track.
    const file = await readFileByKey(await getRoot(), source.key).catch(() => null);
    if (!file) return undefined;
    const url = create(file);
    return { kind: 'opfs', url, revoke: () => revokeUrl(url) };
  }
  if (source.kind === 'drive') return { kind: 'unsupported', reason: 'drive-not-wired' };
  if (source.kind === 'remote') return { kind: 'remote', url: source.url };
  return { kind: 'external', downloadId: source.downloadId };
}
