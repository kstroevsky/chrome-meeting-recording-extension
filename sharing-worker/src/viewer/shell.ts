const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export function viewerShell(): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Shared recording</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #0c0d10; color: #f4f5f7; }
    button, input { font: inherit; }
    button { color: inherit; }
    .shell { width: min(1220px, calc(100% - 32px)); margin: 0 auto; padding: 30px 0 48px; }
    .top { display: flex; gap: 18px; align-items: flex-start; justify-content: space-between; margin-bottom: 18px; }
    .eyebrow { margin: 0 0 7px; color: #9da3ae; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(22px, 3vw, 34px); letter-spacing: -.025em; }
    .recordings { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .recordings button, .topic, .note, .transcript-line { border: 1px solid #2e3239; background: #17191e; border-radius: 10px; cursor: pointer; }
    .recordings button { padding: 8px 12px; }
    .recordings button[aria-current="true"] { background: #f4f5f7; color: #101216; border-color: #f4f5f7; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 360px); gap: 18px; align-items: start; }
    .card { border: 1px solid #262a31; background: #121419; border-radius: 16px; overflow: hidden; box-shadow: 0 18px 60px rgba(0,0,0,.28); }
    .stage { position: relative; min-height: 280px; display: grid; place-items: center; background: #050607; }
    .stage > video.master { width: 100%; max-height: 72vh; display: block; background: #050607; }
    .stage > audio.master { width: min(680px, calc(100% - 40px)); }
    .aux-video { position: absolute; right: 18px; bottom: 18px; width: min(28%, 270px); aspect-ratio: 16 / 9; object-fit: cover; border: 1px solid rgba(255,255,255,.2); border-radius: 12px; background: #090a0c; box-shadow: 0 10px 35px rgba(0,0,0,.45); }
    .meta { display: grid; gap: 14px; padding: 16px 18px 18px; }
    .meta-row { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px 18px; align-items: center; }
    .time { color: #aeb3bd; font-variant-numeric: tabular-nums; font-size: 13px; }
    .mixers { display: flex; flex-wrap: wrap; gap: 12px 18px; }
    .mixer { display: grid; grid-template-columns: auto minmax(90px, 150px) 42px; gap: 8px; align-items: center; color: #d9dce2; font-size: 13px; }
    .mixer input { width: 100%; }
    .mixer output { color: #9da3ae; text-align: right; font-variant-numeric: tabular-nums; }
    .panel { padding: 18px; }
    .panel + .panel { border-top: 1px solid #262a31; }
    .panel h2 { margin: 0 0 12px; font-size: 13px; color: #aeb3bd; letter-spacing: .09em; text-transform: uppercase; }
    .topics, .notes { display: flex; flex-wrap: wrap; gap: 8px; }
    .topic, .note { padding: 8px 10px; text-align: left; }
    .topic:hover, .note:hover, .transcript-line:hover { border-color: #555c68; }
    .topic small, .note small { display: block; color: #9299a4; margin-top: 3px; }
    .transcript { display: grid; gap: 6px; max-height: 56vh; overflow: auto; padding-right: 4px; }
    .transcript-line { width: 100%; padding: 10px 11px; text-align: left; line-height: 1.4; }
    .transcript-line strong { display: block; margin-bottom: 3px; font-size: 12px; color: #9da3ae; font-weight: 600; }
    .transcript-line.active { border-color: #8f98a7; background: #23262d; }
    .empty { color: #8f96a1; font-size: 14px; }
    .unavailable { min-height: 70vh; display: grid; place-items: center; text-align: center; padding: 32px; }
    .unavailable h1 { margin-bottom: 10px; }
    .unavailable p { color: #9da3ae; max-width: 480px; line-height: 1.55; }
    [hidden] { display: none !important; }
    @media (max-width: 860px) {
      .shell { width: min(100% - 20px, 760px); padding-top: 18px; }
      .top { display: grid; }
      .recordings { justify-content: flex-start; }
      .layout { grid-template-columns: 1fr; }
      .stage { min-height: 220px; }
      .transcript { max-height: 440px; }
      .aux-video { width: 34%; right: 10px; bottom: 10px; }
    }
  </style>
</head>
<body>
  <main id="app" class="shell">
    <header class="top">
      <div>
        <p class="eyebrow">Shared recording</p>
        <h1 id="recording-title">Loading…</h1>
      </div>
      <nav id="recordings" class="recordings" aria-label="Recordings in this share"></nav>
    </header>
    <div id="viewer" class="layout" hidden>
      <section class="card">
        <div id="stage" class="stage" aria-label="Recording player"></div>
        <div class="meta">
          <div class="meta-row">
            <span id="clock" class="time">0:00 / 0:00</span>
            <div id="mixers" class="mixers" aria-label="Track volume"></div>
          </div>
        </div>
      </section>
      <aside class="card">
        <section id="topics-panel" class="panel" hidden>
          <h2>Topics</h2>
          <div id="topics" class="topics"></div>
        </section>
        <section id="notes-panel" class="panel" hidden>
          <h2>Notes</h2>
          <div id="notes" class="notes"></div>
        </section>
        <section id="transcript-panel" class="panel" hidden>
          <h2>Transcript</h2>
          <div id="transcript" class="transcript"></div>
        </section>
      </aside>
    </div>
    <section id="unavailable" class="unavailable" hidden>
      <div>
        <h1>This share is no longer available</h1>
        <p>The owner may have revoked it, or this viewing session may have expired.</p>
      </div>
    </section>
  </main>
  <script type="module" src="/viewer/app.js"></script>
</body>
</html>`, {
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; media-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

export function viewerAppScript(): Response {
  return new Response(VIEWER_APP_JS, {
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/javascript; charset=utf-8',
    },
  });
}

const VIEWER_APP_JS = String.raw`
const byId = (id) => document.getElementById(id);
const title = byId('recording-title');
const recordingNav = byId('recordings');
const viewer = byId('viewer');
const stage = byId('stage');
const clock = byId('clock');
const mixers = byId('mixers');
const transcriptPanel = byId('transcript-panel');
const transcriptList = byId('transcript');
const topicsPanel = byId('topics-panel');
const topicsList = byId('topics');
const notesPanel = byId('notes-panel');
const notesList = byId('notes');
const unavailable = byId('unavailable');

const state = {
  manifest: null,
  recording: null,
  masterTrack: null,
  master: null,
  elements: new Map(),
  auxiliaries: [],
  driftTimer: null,
  activeTranscript: -1,
};

boot().catch(showUnavailable);

async function boot() {
  const response = await fetch('/viewer/manifest', { cache: 'no-store' });
  if (!response.ok) return showUnavailable();
  const manifest = await response.json();
  if (!manifest || !Array.isArray(manifest.recordings) || manifest.recordings.length === 0) return showUnavailable();
  state.manifest = manifest;
  renderRecordingNav(manifest.recordings);
  await loadRecording(manifest.recordings[0]);
}

function renderRecordingNav(recordings) {
  recordingNav.replaceChildren();
  recordingNav.hidden = recordings.length < 2;
  recordings.forEach((recording, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = recording.title || 'Recording ' + (index + 1);
    button.dataset.recordingId = recording.id;
    button.addEventListener('click', () => { void loadRecording(recording); });
    recordingNav.append(button);
  });
}

async function loadRecording(recording) {
  stopPlayback();
  state.recording = recording;
  title.textContent = recording.title || 'Shared recording';
  viewer.hidden = false;
  unavailable.hidden = true;
  for (const button of recordingNav.querySelectorAll('button')) {
    button.setAttribute('aria-current', String(button.dataset.recordingId === recording.id));
  }

  renderTopics(recording.topics || []);
  renderNotes(recording.notations || []);
  renderTranscript(recording.transcript && Array.isArray(recording.transcript.segments) ? recording.transcript.segments : []);

  const tracks = Array.isArray(recording.tracks) ? recording.tracks : [];
  const masterTrack = tracks.find((track) => track.stream === 'tab') || tracks[0];
  if (!masterTrack) return showUnavailable();
  state.masterTrack = masterTrack;

  const master = mediaElement(masterTrack, true);
  master.classList.add('master');
  master.controls = true;
  master.preload = 'metadata';
  master.src = masterTrack.mediaEndpoint;
  stage.append(master);
  state.master = master;
  state.elements.set(masterTrack.id, master);
  bindMaster(master);

  for (const track of tracks) {
    if (track.id === masterTrack.id) continue;
    const element = mediaElement(track, false);
    element.preload = 'metadata';
    element.src = track.mediaEndpoint;
    if (track.stream === 'self-video') {
      element.classList.add('aux-video');
      element.muted = true;
      element.playsInline = true;
      stage.append(element);
    } else {
      element.hidden = true;
      stage.append(element);
    }
    state.elements.set(track.id, element);
    state.auxiliaries.push({ track, element });
  }
  renderMixers(tracks);
}

function mediaElement(track, master) {
  const element = document.createElement(track.stream === 'mic' ? 'audio' : 'video');
  element.dataset.trackId = track.id;
  if (master && track.stream !== 'mic') element.playsInline = true;
  element.addEventListener('error', () => {
    if (element === state.master) showUnavailable();
  });
  return element;
}

function bindMaster(master) {
  master.addEventListener('play', () => {
    alignAuxiliaries();
    for (const item of state.auxiliaries) void item.element.play().catch(() => {});
    startDriftWatch();
  });
  master.addEventListener('pause', () => {
    for (const item of state.auxiliaries) item.element.pause();
    stopDriftWatch();
  });
  master.addEventListener('seeking', alignAuxiliaries);
  master.addEventListener('seeked', alignAuxiliaries);
  master.addEventListener('ratechange', () => {
    for (const item of state.auxiliaries) item.element.playbackRate = master.playbackRate;
  });
  master.addEventListener('loadedmetadata', updatePosition);
  master.addEventListener('durationchange', updatePosition);
  master.addEventListener('timeupdate', () => {
    updatePosition();
    syncTranscript(master.currentTime * 1000);
  });
}

function alignAuxiliaries() {
  if (!state.master || !state.masterTrack) return;
  for (const item of state.auxiliaries) {
    const offsetSeconds = ((item.track.captureStartOffsetMs || 0) - (state.masterTrack.captureStartOffsetMs || 0)) / 1000;
    const target = Math.max(0, state.master.currentTime - offsetSeconds);
    if (Number.isFinite(target)) item.element.currentTime = target;
    item.element.playbackRate = state.master.playbackRate;
  }
}

function startDriftWatch() {
  if (state.driftTimer) return;
  state.driftTimer = setInterval(() => {
    if (!state.master || !state.masterTrack) return;
    for (const item of state.auxiliaries) {
      const offsetSeconds = ((item.track.captureStartOffsetMs || 0) - (state.masterTrack.captureStartOffsetMs || 0)) / 1000;
      const target = Math.max(0, state.master.currentTime - offsetSeconds);
      if (Math.abs(item.element.currentTime - target) * 1000 > 150) item.element.currentTime = target;
    }
  }, 400);
}

function stopDriftWatch() {
  if (!state.driftTimer) return;
  clearInterval(state.driftTimer);
  state.driftTimer = null;
}

function stopPlayback() {
  stopDriftWatch();
  if (state.master) state.master.pause();
  for (const item of state.auxiliaries) item.element.pause();
  stage.replaceChildren();
  mixers.replaceChildren();
  state.master = null;
  state.masterTrack = null;
  state.elements.clear();
  state.auxiliaries = [];
  state.activeTranscript = -1;
}

function renderMixers(tracks) {
  mixers.replaceChildren();
  for (const track of tracks) {
    if (track.stream === 'self-video') continue;
    const element = state.elements.get(track.id);
    if (!element) continue;
    const row = document.createElement('label');
    row.className = 'mixer';
    const name = document.createElement('span');
    name.textContent = track.stream === 'mic' ? 'Mic' : track.stream === 'tab' ? 'Meeting' : track.stream;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.01';
    slider.value = '1';
    slider.setAttribute('aria-label', name.textContent + ' volume');
    const output = document.createElement('output');
    output.textContent = '100%';
    slider.addEventListener('input', () => {
      const level = Number(slider.value);
      element.volume = level;
      element.muted = level === 0;
      output.textContent = Math.round(level * 100) + '%';
    });
    row.append(name, slider, output);
    mixers.append(row);
  }
}

function renderTranscript(segments) {
  transcriptList.replaceChildren();
  transcriptPanel.hidden = segments.length === 0;
  segments.forEach((segment, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'transcript-line';
    row.dataset.index = String(index);
    const meta = document.createElement('strong');
    meta.textContent = formatTime((segment.tStartMs || 0) / 1000) + (segment.speaker ? ' · ' + segment.speaker : '');
    const text = document.createElement('span');
    text.textContent = segment.text || '';
    row.append(meta, text);
    row.addEventListener('click', () => seekMs(segment.tStartMs || 0));
    transcriptList.append(row);
  });
}

function syncTranscript(positionMs) {
  const segments = state.recording && state.recording.transcript ? state.recording.transcript.segments || [] : [];
  let next = -1;
  for (let i = 0; i < segments.length; i += 1) {
    if (positionMs >= segments[i].tStartMs && positionMs <= segments[i].tEndMs) { next = i; break; }
  }
  if (next === state.activeTranscript) return;
  const previous = transcriptList.querySelector('.active');
  if (previous) previous.classList.remove('active');
  if (next >= 0) {
    const current = transcriptList.querySelector('[data-index="' + next + '"]');
    if (current) {
      current.classList.add('active');
      current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  state.activeTranscript = next;
}

function renderTopics(topics) {
  topicsList.replaceChildren();
  topicsPanel.hidden = topics.length === 0;
  for (const topic of topics) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'topic';
    const label = document.createElement('span');
    label.textContent = (topic.keywords || []).slice(0, 3).join(' · ') || 'Topic';
    const meta = document.createElement('small');
    meta.textContent = formatDuration(topic.totalMs || 0);
    button.append(label, meta);
    button.addEventListener('click', () => seekMs(topic.spans && topic.spans[0] ? topic.spans[0].tStartMs : 0));
    topicsList.append(button);
  }
}

function renderNotes(notes) {
  notesList.replaceChildren();
  notesPanel.hidden = notes.length === 0;
  for (const note of notes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'note';
    const label = document.createElement('span');
    label.textContent = note.text || 'Note';
    const meta = document.createElement('small');
    meta.textContent = formatTime((note.tStartMs || 0) / 1000);
    button.append(label, meta);
    button.addEventListener('click', () => seekMs(note.tStartMs || 0));
    notesList.append(button);
  }
}

function seekMs(ms) {
  if (!state.master) return;
  state.master.currentTime = Math.max(0, ms / 1000);
  alignAuxiliaries();
}

function updatePosition() {
  if (!state.master) return;
  const duration = Number.isFinite(state.master.duration)
    ? state.master.duration
    : state.recording && Number.isFinite(state.recording.durationMs) ? state.recording.durationMs / 1000 : 0;
  clock.textContent = formatTime(state.master.currentTime) + ' / ' + formatTime(duration);
}

function formatTime(seconds) {
  const value = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return minutes + ':' + String(rest).padStart(2, '0');
}

function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes + (minutes === 1 ? ' min' : ' min');
}

function showUnavailable() {
  stopPlayback();
  viewer.hidden = true;
  unavailable.hidden = false;
  title.textContent = 'Shared recording';
}
`;
