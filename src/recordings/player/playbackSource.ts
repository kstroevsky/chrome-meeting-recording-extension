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
  return { kind: 'external', downloadId: source.downloadId };
}
