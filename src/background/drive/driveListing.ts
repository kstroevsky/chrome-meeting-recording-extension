/**
 * @file background/drive/driveListing.ts
 *
 * Lists a Drive folder with the extension's own (narrow) permission — every
 * page of it. Shared by the destination import and "Sync with Drive".
 */

import type { DriveListedFile } from './driveDestinationImport';
import { fetchDriveTokenWithFallback } from './driveAuth';

const FILES = 'https://www.googleapis.com/drive/v3/files';

/** Every live child of a Drive folder, files and folders alike, across pages. */
export async function listDriveChildren(folderId: string): Promise<Array<DriveListedFile & { mimeType?: string }>> {
  const query = encodeURIComponent(`'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`);
  const children: Array<DriveListedFile & { mimeType?: string }> = [];
  let pageToken = '';
  do {
    const auth = await fetchDriveTokenWithFallback();
    if (!auth.ok) throw new Error(auth.error);
    const response = await fetch(`${FILES}?q=${query}&pageSize=1000`
      + `&fields=nextPageToken,files(id,name,mimeType,size,webViewLink)${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      { headers: { Authorization: `Bearer ${auth.token}` } });
    if (!response.ok) throw new Error(`Drive folder listing ${response.status}`);
    const body = await response.json();
    children.push(...(body?.files ?? []));
    pageToken = body?.nextPageToken ?? '';
  } while (pageToken);
  return children;
}
