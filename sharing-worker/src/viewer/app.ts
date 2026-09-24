import { PlaybackClock } from '../../../src/shared/player/PlaybackClock';
import type {
  PublishedPlaybackManifest,
  SharedPlaybackTrack,
  SharedRecording,
} from '../../../src/shared/sharing';
import type { PlaybackTopic } from '../../../src/shared/playback';
import type { RecordingNotation } from '../../../src/shared/notations';
import type { TranscriptSegment } from '../../../src/shared/transcript';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing viewer element: ${id}`);
  return element as T;
}

const title = byId<HTMLElement>('recording-title');
const recordingNav = byId<HTMLElement>('recordings');
const viewer = byId<HTMLElement>('viewer');
const stage = byId<HTMLElement>('stage');
const clockLabel = byId<HTMLElement>('clock');
const mixers = byId<HTMLElement>('mixers');
const transcriptPanel = byId<HTMLElement>('transcript-panel');
const transcriptList = byId<HTMLElement>('transcript');
const topicsPanel = byId<HTMLElement>('topics-panel');
const topicsList = byId<HTMLElement>('topics');
const notesPanel = byId<HTMLElement>('notes-panel');
const notesList = byId<HTMLElement>('notes');
const unavailable = byId<HTMLElement>('unavailable');

const state: {
  manifest: PublishedPlaybackManifest | null;
  recording: SharedRecording | null;
  masterTrack: SharedPlaybackTrack | null;
  master: HTMLMediaElement | null;
  elements: Map<string, HTMLMediaElement>;
  playbackClock: PlaybackClock | null;
  driftTimer: ReturnType<typeof setInterval> | null;
  activeTranscript: number;
} = {
  manifest: null,
  recording: null,
  masterTrack: null,
  master: null,
  elements: new Map(),
  playbackClock: null,
  driftTimer: null,
  activeTranscript: -1,
};

void boot().catch(showUnavailable);

async function boot(): Promise<void> {
  const response = await fetch('/viewer/manifest', { cache: 'no-store' });
  if (!response.ok) return showUnavailable();
  const manifest = await response.json() as PublishedPlaybackManifest;
  if (!manifest || !Array.isArray(manifest.recordings) || manifest.recordings.length === 0) {
    return showUnavailable();
  }
  state.manifest = manifest;
  renderRecordingNav(manifest.recordings);
  await loadRecording(manifest.recordings[0]);
}

function renderRecordingNav(recordings: SharedRecording[]): void {
  recordingNav.replaceChildren();
  recordingNav.hidden = recordings.length < 2;
  recordings.forEach((recording, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = recording.title || `Recording ${index + 1}`;
    button.dataset.recordingId = recording.id;
    button.addEventListener('click', () => { void loadRecording(recording); });
    recordingNav.append(button);
  });
}

async function loadRecording(recording: SharedRecording): Promise<void> {
  stopPlayback();
  state.recording = recording;
  title.textContent = recording.title || 'Shared recording';
  viewer.hidden = false;
  unavailable.hidden = true;
  for (const button of recordingNav.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-current', String(button.dataset.recordingId === recording.id));
  }

  renderTopics(recording.topics ?? []);
  renderNotes(recording.notations ?? []);
  renderTranscript(recording.transcript?.segments ?? []);

  const tracks = recording.tracks ?? [];
  const masterTrack = tracks.find((track) => track.stream === 'tab') ?? tracks[0];
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
  state.playbackClock = new PlaybackClock(master);
  bindMaster(master);

  for (const track of tracks) {
    if (track.id === masterTrack.id) continue;
    const element = mediaElement(track, false);
    element.preload = 'metadata';
    element.src = track.mediaEndpoint;
    if (track.stream === 'self-video') {
      element.classList.add('aux-video');
      element.muted = true;
      if (element instanceof HTMLVideoElement) element.playsInline = true;
      stage.append(element);
    } else {
      element.hidden = true;
      stage.append(element);
    }
    state.elements.set(track.id, element);
    state.playbackClock.add({
      element,
      timelineOffsetMs: track.captureStartOffsetMs - masterTrack.captureStartOffsetMs,
    });
  }
  renderMixers(tracks);
}

function mediaElement(track: SharedPlaybackTrack, master: boolean): HTMLMediaElement {
  const element = document.createElement(track.stream === 'mic' ? 'audio' : 'video');
  element.dataset.trackId = track.id;
  if (master && element instanceof HTMLVideoElement) element.playsInline = true;
  element.addEventListener('error', () => {
    if (element === state.master) showUnavailable();
  });
  return element;
}

function bindMaster(master: HTMLMediaElement): void {
  master.addEventListener('play', () => {
    state.playbackClock?.syncFromMaster();
    startDriftWatch();
  });
  master.addEventListener('pause', () => {
    state.playbackClock?.syncFromMaster();
    stopDriftWatch();
  });
  master.addEventListener('seeking', () => state.playbackClock?.syncFromMaster());
  master.addEventListener('seeked', () => state.playbackClock?.syncFromMaster());
  master.addEventListener('ratechange', () => state.playbackClock?.setPlaybackRate(master.playbackRate));
  master.addEventListener('loadedmetadata', updatePosition);
  master.addEventListener('durationchange', updatePosition);
  master.addEventListener('timeupdate', () => {
    updatePosition();
    syncTranscript(master.currentTime * 1000);
  });
}

function startDriftWatch(): void {
  if (state.driftTimer) return;
  state.driftTimer = setInterval(() => state.playbackClock?.correctDrift(), 400);
}

function stopDriftWatch(): void {
  if (!state.driftTimer) return;
  clearInterval(state.driftTimer);
  state.driftTimer = null;
}

function stopPlayback(): void {
  stopDriftWatch();
  state.playbackClock?.pause();
  stage.replaceChildren();
  mixers.replaceChildren();
  state.master = null;
  state.masterTrack = null;
  state.elements.clear();
  state.playbackClock = null;
  state.activeTranscript = -1;
}

function renderMixers(tracks: SharedPlaybackTrack[]): void {
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
    slider.setAttribute('aria-label', `${name.textContent} volume`);
    const output = document.createElement('output');
    output.textContent = '100%';
    slider.addEventListener('input', () => {
      const level = Number(slider.value);
      element.volume = level;
      element.muted = level === 0;
      output.textContent = `${Math.round(level * 100)}%`;
    });
    row.append(name, slider, output);
    mixers.append(row);
  }
}

function renderTranscript(segments: TranscriptSegment[]): void {
  transcriptList.replaceChildren();
  transcriptPanel.hidden = segments.length === 0;
  segments.forEach((segment, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'transcript-line';
    row.dataset.index = String(index);
    const meta = document.createElement('strong');
    meta.textContent = `${formatTime(segment.tStartMs / 1000)}${segment.speaker ? ` · ${segment.speaker}` : ''}`;
    const text = document.createElement('span');
    text.textContent = segment.text;
    row.append(meta, text);
    row.addEventListener('click', () => seekMs(segment.tStartMs));
    transcriptList.append(row);
  });
}

function syncTranscript(positionMs: number): void {
  const segments = state.recording?.transcript?.segments ?? [];
  let next = -1;
  for (let index = 0; index < segments.length; index += 1) {
    if (positionMs >= segments[index].tStartMs && positionMs <= segments[index].tEndMs) {
      next = index;
      break;
    }
  }
  if (next === state.activeTranscript) return;
  transcriptList.querySelector('.active')?.classList.remove('active');
  if (next >= 0) {
    const current = transcriptList.querySelector<HTMLElement>(`[data-index="${next}"]`);
    if (current) {
      current.classList.add('active');
      current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  state.activeTranscript = next;
}

function renderTopics(topics: PlaybackTopic[]): void {
  topicsList.replaceChildren();
  topicsPanel.hidden = topics.length === 0;
  for (const topic of topics) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'topic';
    const label = document.createElement('span');
    label.textContent = topic.keywords.slice(0, 3).join(' · ') || 'Topic';
    const meta = document.createElement('small');
    meta.textContent = formatDuration(topic.totalMs);
    button.append(label, meta);
    button.addEventListener('click', () => seekMs(topic.spans[0]?.tStartMs ?? 0));
    topicsList.append(button);
  }
}

function renderNotes(notes: RecordingNotation[]): void {
  notesList.replaceChildren();
  notesPanel.hidden = notes.length === 0;
  for (const note of notes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'note';
    const label = document.createElement('span');
    label.textContent = note.text || 'Note';
    const meta = document.createElement('small');
    meta.textContent = formatTime(note.tStartMs / 1000);
    button.append(label, meta);
    button.addEventListener('click', () => seekMs(note.tStartMs));
    notesList.append(button);
  }
}

function seekMs(ms: number): void {
  if (!state.master) return;
  if (state.playbackClock) state.playbackClock.seek(ms);
  else state.master.currentTime = Math.max(0, ms / 1000);
}

function updatePosition(): void {
  if (!state.master) return;
  const duration = Number.isFinite(state.master.duration)
    ? state.master.duration
    : state.recording?.durationMs != null ? state.recording.durationMs / 1000 : 0;
  clockLabel.textContent = `${formatTime(state.master.currentTime)} / ${formatTime(duration)}`;
}

function formatTime(seconds: number): string {
  const value = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} min`;
}

function showUnavailable(): void {
  stopPlayback();
  viewer.hidden = true;
  unavailable.hidden = false;
  title.textContent = 'Shared recording';
}
