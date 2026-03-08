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

/** Size of each resumable upload chunk for finished-file Drive uploads. */
export const DRIVE_UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;

/** Per-request timeout for Drive HTTP calls. */
export const DRIVE_REQUEST_TIMEOUT_MS = 180_000;

/** Max retry count for transient upload failures. */
export const DRIVE_MAX_RETRIES = 5;

/** Base delay for exponential backoff between transient retries. */
export const DRIVE_RETRY_BASE_DELAY_MS = 1_000;
