/**
 * @file sharing/ShareUploadSourceResolver.ts
 *
 * Resolves an owner-private playback track into a random-access source for the
 * sharing uploader. OPFS is preferred because the bytes are already local.
 * Drive falls back to authenticated Range GETs so a multi-gigabyte recording is
 * never materialized in memory. Downloads entries cannot be read by extensions.
 */

import type { PlaybackTrack } from '../shared/playback';
import { readFileByKey, type DirectoryHandleLike } from '../offscreen/storage/opfsLayout';
import { createCachedTokenProvider, driveFetch, fetchWithAuthRetry, type TokenProvider } from '../offscreen/drive/request';
import type { ShareUploadSource, ShareUploadSourceResolver } from './ShareUploadManager';

const DRIVE_MEDIA_ORIGIN = 'https://www.googleapis.com';

export type ShareUploadSourceResolverDeps = {
  getRoot?: () => Promise<DirectoryHandleLike>;
  getDriveToken?: TokenProvider;
  fetch?: typeof fetch;
};

export function createShareUploadSourceResolver(
  deps: ShareUploadSourceResolverDeps = {},
): ShareUploadSourceResolver {
  const getRoot = deps.getRoot ?? (() => navigator.storage.getDirectory() as unknown as Promise<DirectoryHandleLike>);
  const getDriveToken = deps.getDriveToken ? createCachedTokenProvider(deps.getDriveToken) : undefined;

  return async (track: PlaybackTrack) => {
    for (const source of track.sources) {
      if (source.kind === 'opfs') {
        const file = await readFileByKey(await getRoot(), source.key).catch(() => null);
        if (file) return blobSource(file);
      }
      if (source.kind === 'drive') {
        if (!getDriveToken) continue;
        return await driveSource(source.fileId, track.bytes, getDriveToken, resolveFetcher(deps.fetch));
      }
    }
    throw new Error(`No readable source is available for ${track.stream}; downloaded files cannot be read by the extension`);
  };
}

function resolveFetcher(injected?: typeof fetch): typeof fetch {
  if (injected) return injected;
  return driveFetch;
}

function blobSource(blob: Blob): ShareUploadSource {
  return {
    size: blob.size,
    async read(start, end) {
      validateRange(start, end, blob.size);
      return blob.slice(start, end);
    },
  };
}

async function driveSource(
  fileId: string,
  knownBytes: number | undefined,
  getToken: TokenProvider,
  fetcher: typeof fetch,
): Promise<ShareUploadSource> {
  const url = `${DRIVE_MEDIA_ORIGIN}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const size = knownBytes ?? await probeDriveSize(url, getToken, fetcher);
  return {
    size,
    async read(start, end, signal) {
      validateRange(start, end, size);
      const response = await fetchWithAuthRetry(getToken, (token) => fetcher(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Range: `bytes=${start}-${end - 1}`,
        },
        signal,
        cache: 'no-store',
      }));
      if (response.status !== 206) throw new Error(`Drive media range request failed (${response.status})`);
      const blob = await response.blob();
      if (blob.size !== end - start) {
        throw new Error(`Drive returned ${blob.size} bytes for a ${end - start}-byte range`);
      }
      return blob;
    },
  };
}

async function probeDriveSize(url: string, getToken: TokenProvider, fetcher: typeof fetch): Promise<number> {
  const response = await fetchWithAuthRetry(getToken, (token) => fetcher(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-0' },
    cache: 'no-store',
  }));
  if (response.status !== 206) throw new Error(`Could not determine Drive media size (${response.status})`);
  const range = response.headers.get('content-range');
  const match = /^bytes\s+0-0\/(\d+)$/i.exec(range ?? '');
  const size = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Drive returned an invalid media size');
  return size;
}

function validateRange(start: number, end: number, size: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > size) {
    throw new Error(`Invalid source range ${start}-${end} for ${size} bytes`);
  }
}
