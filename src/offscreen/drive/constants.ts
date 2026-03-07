/**
 * @file offscreen/drive/constants.ts
 *
 * Centralized Google Drive REST constants used by the offscreen recorder's
 * cloud upload implementation.
 */

/** Resumable upload endpoint for media file creation. */
export const DRIVE_UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true';

/** Files endpoint used for folder lookup/creation. */
export const DRIVE_FILES_URL =
  'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true';

/** Google Drive MIME type that identifies folders. */
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Root folder used by this extension to keep recordings organized. */
export const DRIVE_ROOT_FOLDER_NAME = 'Google Meet Records';
