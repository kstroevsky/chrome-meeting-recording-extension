/**
 * @file platform/chrome/identity.ts
 *
 * Promise-based wrappers around the Chrome Identity API.
 */

export function getAuthToken(interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (result) => {
      const error = chrome.runtime.lastError?.message;
      if (error) return reject(new Error(error));
      const candidate = result as string | { token?: string } | undefined;
      const token = typeof candidate === 'string' ? candidate : candidate?.token;
      if (!token) return reject(new Error('No OAuth token returned'));
      resolve(token);
    });
  });
}

export function removeCachedAuthToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    const remover = chrome.identity.removeCachedAuthToken as
      | ((details: { token: string }, callback?: () => void) => void)
      | undefined;

    if (!remover) {
      resolve();
      return;
    }

    try {
      remover({ token }, () => resolve());
    } catch {
      resolve();
    }
  });
}

/**
 * Runs an OAuth2 flow in a browser window and resolves with the final redirect
 * URL. The cross-browser path (Edge/Brave/Opera/Firefox) where getAuthToken is
 * Chrome-only; the caller parses the access token out of the redirect.
 */
export function launchWebAuthFlow(url: string, interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (redirectUrl) => {
      const error = chrome.runtime.lastError?.message;
      if (error) return reject(new Error(error));
      if (!redirectUrl) return reject(new Error('launchWebAuthFlow returned no redirect URL'));
      resolve(redirectUrl);
    });
  });
}

/** The extension's OAuth redirect target, e.g. `https://<id>.chromiumapp.org/`. */
export function getRedirectURL(): string {
  return chrome.identity.getRedirectURL();
}
