/**
 * @file background/drive/driveSyncPorts.ts
 *
 * The two Drive reads "Sync with Drive" needs beyond folder listings: a file's
 * state, and a byte range (a recording's first and last kilobytes, for its
 * duration). With the extension's own (narrow) Drive permission.
 */

import type { DriveLibrarySyncDeps } from './DriveLibrarySync';
import { fetchDriveTokenWithFallback } from './driveAuth';

const FILES = 'https://www.googleapis.com/drive/v3/files';

async function driveFetch(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const auth = await fetchDriveTokenWithFallback();
  if (!auth.ok) throw new Error(auth.error);
  return fetch(url, { headers: { Authorization: `Bearer ${auth.token}`, ...headers } });
}

export function createDriveSyncPorts(): Pick<DriveLibrarySyncDeps, 'fileState' | 'readRange'> {
  return {
    async fileState(fileId) {
      const response = await driveFetch(`${FILES}/${encodeURIComponent(fileId)}?fields=id,trashed`);
      if (response.status === 404) return 'missing';
      if (!response.ok) throw new Error(`Google Drive answered ${response.status}`);
      return (await response.json())?.trashed ? 'trashed' : 'ok';
    },
    async readRange(fileId, from, to) {
      const response = await driveFetch(`${FILES}/${encodeURIComponent(fileId)}?alt=media`, { Range: `bytes=${from}-${to}` });
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    },
  };
}
