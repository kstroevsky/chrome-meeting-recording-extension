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

/** Lower bound used by adaptive upload chunk sizing. */
export const DRIVE_MIN_UPLOAD_CHUNK_BYTES = 1 * 1024 * 1024;

/** Upper bound used by adaptive upload chunk sizing. */
export const DRIVE_MAX_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/** Step size used when adaptive chunk sizing is enabled. */
export const DRIVE_UPLOAD_CHUNK_STEP_BYTES = 1 * 1024 * 1024;

/** Consecutive uploads faster than this are eligible to increase chunk size. */
export const DRIVE_FAST_CHUNK_MS = 1_500;

/** Slow uploads or retries above this threshold reduce chunk size immediately. */
export const DRIVE_SLOW_CHUNK_MS = 8_000;

/** Per-request timeout for Drive HTTP calls. */
export const DRIVE_REQUEST_TIMEOUT_MS = 180_000;

/** Max retry count for transient upload failures. */
export const DRIVE_MAX_RETRIES = 5;

/** Base delay for exponential backoff between transient retries. */
export const DRIVE_RETRY_BASE_DELAY_MS = 1_000;
