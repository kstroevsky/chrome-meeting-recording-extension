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
