/**
 * @file background/drive/recordingFileDeletionPorts.ts
 *
 * The real Drive and Downloads operations behind "delete its files", with the
 * extension's own (narrow) Drive permission — every file it deletes is one it
 * owns.
 */

import { removeDownloadedFile } from '../../platform/chrome/downloads';
import type { RecordingFileDeletionDeps } from '../library/history/RecordingFileDeletion';
import { fetchDriveTokenWithFallback } from './driveAuth';

const FILES = 'https://www.googleapis.com/drive/v3/files';

async function drive(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const auth = await fetchDriveTokenWithFallback();
  if (!auth.ok) throw new Error(auth.error);
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${auth.token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

export function createRecordingFileDeletionPorts(): RecordingFileDeletionDeps {
  return {
    async trashDriveFile(fileId) {
      const { status, body } = await drive(`${FILES}/${encodeURIComponent(fileId)}?fields=id,trashed`, {
        method: 'PATCH',
        body: JSON.stringify({ trashed: true }),
      });
      // Under the narrow permission a 404 means "gone" *or* "not one the
      // extension can see" — said as such, never counted as deleted.
      if (status === 404) throw new Error('not found in Google Drive (already gone, or not reachable by the extension)');
      if (status !== 200 || body?.trashed !== true) throw new Error(`Google Drive answered ${status}`);
    },
    async removeDownload(downloadId) {
      try {
        await removeDownloadedFile(downloadId);
      } catch (error) {
        // A file already missing from disk is what was asked for.
        // (Chrome's wording is not a contract; anything else is reported, never hidden.)
        if (/already deleted|does not exist|not found|missing/i.test(error instanceof Error ? error.message : '')) return;
        throw error;
      }
    },
  };
}
