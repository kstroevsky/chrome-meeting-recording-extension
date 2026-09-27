async function fetchResult(url, surface) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ surface }),
    });
    return { ok: true, status: response.status, type: response.type };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

let permissionTarget;
document.querySelector('#request-host').addEventListener('click', async () => {
  const output = document.querySelector('#request-result');
  output.value = 'pending';
  try {
    const granted = permissionTarget
      ? await chrome.permissions.request({ origins: [permissionTarget] })
      : false;
    output.value = granted ? 'granted' : 'denied';
  } catch (error) {
    output.value = `error:${String(error)}`;
  }
});

window.__integrationNetworkSpike = {
  pageFetch: (url) => fetchResult(url, 'extension-page'),
  workerFetch: (url) => chrome.runtime.sendMessage({ type: 'SPIKE_FETCH', url }),
  permissionPattern(url) {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}/*`;
  },
  hasPermission(url) {
    const pattern = this.permissionPattern(url);
    return chrome.permissions.contains({ origins: [pattern] });
  },
  requestPermission(url) {
    const pattern = this.permissionPattern(url);
    return chrome.permissions.request({ origins: [pattern] });
  },
  preparePermissionRequest(url) {
    permissionTarget = this.permissionPattern(url);
    document.querySelector('#request-result').value = 'ready';
    return permissionTarget;
  },
  permissionRequestResult() {
    return document.querySelector('#request-result').value;
  },
  removePermission(url) {
    const pattern = this.permissionPattern(url);
    return chrome.permissions.remove({ origins: [pattern] });
  },
};
