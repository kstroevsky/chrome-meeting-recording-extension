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

export type DownloadSettledResult = 'complete' | 'interrupted' | 'timeout';

/**
 * Resolves when a download reaches a terminal state ('complete' or 'interrupted'),
 * or 'timeout' if no terminal event arrives within `timeoutMs`.
 *
 * Event-driven on `chrome.downloads.onChanged` (the download event wakes a
 * suspended MV3 worker), so callers can react to the *actual* completion instead
 * of a blind timer that a sleeping worker would silently drop. An up-front
 * `search` also covers the race where the download already finished before the
 * listener was attached.
 */
export function awaitDownloadSettled(
  downloadId: number,
  timeoutMs = 10 * 60_000
): Promise<DownloadSettledResult> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: DownloadSettledResult) => {
      if (done) return;
      done = true;
      try { chrome.downloads.onChanged.removeListener(onChanged); } catch { /* not attached */ }
      clearTimeout(timer);
      resolve(result);
    };
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      const state = delta.state?.current;
      if (state === 'complete') finish('complete');
      else if (state === 'interrupted') finish('interrupted');
    };
    chrome.downloads.onChanged.addListener(onChanged);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    // Cover the race where the download settled before the listener attached.
    try {
      chrome.downloads.search({ id: downloadId }, (items) => {
        void chrome.runtime.lastError; // ignore; the listener/timeout still cover us
        const state = items?.[0]?.state;
        if (state === 'complete') finish('complete');
        else if (state === 'interrupted') finish('interrupted');
      });
    } catch { /* search unavailable; rely on the listener + timeout */ }
  });
}
