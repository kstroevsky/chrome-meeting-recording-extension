async function fetchResult(url) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ surface: 'service-worker' }),
    });
    return { ok: true, status: response.status, type: response.type };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SPIKE_FETCH' || typeof message.url !== 'string') return false;
  fetchResult(message.url).then(sendResponse);
  return true;
});
