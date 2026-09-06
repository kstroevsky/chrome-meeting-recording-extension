/** Throwaway spike page. Receives only a Drive URL — never a token. */

const video = document.getElementById('v');
const logEl = document.getElementById('log');
const lines = [];
const log = (msg) => { lines.push(msg); logEl.textContent = lines.join('\n'); };

window.__spikeLog = () => lines.slice();

/** Ask background to authorize this tab, then point the element at Drive. */
window.__spikeLoad = async (fileIdOrUrl) => {
  const url = /^https?:\/\//.test(fileIdOrUrl)
    ? fileIdOrUrl
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileIdOrUrl)}?alt=media`;
  const installed = await chrome.runtime.sendMessage({ type: 'SPIKE_INSTALL_RULE', mediaUrl: url });
  log(`rule: ${JSON.stringify(installed)}`);
  if (!installed?.ok) throw new Error(installed?.error ?? 'rule install failed');

  const ready = new Promise((resolve, reject) => {
    video.addEventListener('loadedmetadata', () => resolve({ duration: video.duration }), { once: true });
    video.addEventListener('error', () => reject(new Error(`media error: ${video.error?.code} ${video.error?.message ?? ''}`)), { once: true });
    setTimeout(() => reject(new Error('timed out waiting for loadedmetadata')), 60_000);
  });
  video.src = url;
  const meta = await ready;
  log(`loadedmetadata duration=${meta.duration}`);
  return { ...meta, url, rule: installed.rule };
};

window.__spikeSeek = (fraction) => new Promise((resolve, reject) => {
  const target = video.duration * fraction;
  const onSeeked = () => resolve({ target, currentTime: video.currentTime, buffered: ranges() });
  video.addEventListener('seeked', onSeeked, { once: true });
  video.addEventListener('error', () => reject(new Error('media error during seek')), { once: true });
  setTimeout(() => reject(new Error('timed out waiting for seeked')), 60_000);
  video.currentTime = target;
});

window.__spikePlay = async (ms) => {
  await video.play();
  await new Promise((r) => setTimeout(r, ms));
  video.pause();
  return { currentTime: video.currentTime, buffered: ranges() };
};

function ranges() {
  const out = [];
  for (let i = 0; i < video.buffered.length; i += 1) {
    out.push([Number(video.buffered.start(i).toFixed(2)), Number(video.buffered.end(i).toFixed(2))]);
  }
  return out;
}

/** Surfaces for the leak assertions. */
window.__spikeSurfaces = () => ({
  url: location.href,
  videoSrc: video.getAttribute('src') ?? '',
  documentHtml: document.documentElement.outerHTML,
  localStorage: JSON.stringify({ ...localStorage }),
  log: lines.join('\n'),
});
