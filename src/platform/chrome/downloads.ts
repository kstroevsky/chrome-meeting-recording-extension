/**
 * @file platform/chrome/downloads.ts
 *
 * Promise-based wrapper around `chrome.downloads.download`.
 */

export function downloadFile(options: chrome.downloads.DownloadOptions): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const error = chrome.runtime.lastError?.message;
      if (error) return reject(new Error(error));
      resolve(downloadId);
    });
  });
}
