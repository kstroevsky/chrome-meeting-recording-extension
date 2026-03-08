/**
 * @file popup/PopupController.ts
 *
 * Stateful popup controller. The popup is intentionally thin and disposable:
 * it initiates actions, reflects current recording/uploading state, and can be
 * closed/reopened at any time without owning the recording lifecycle.
 */

import { CameraPermissionService } from './CameraPermissionService';
import { MicPermissionService } from './MicPermissionService';
import type { RecordingPhase, RecordingRunConfig, UploadSummary } from '../shared/protocol';
import {
  PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
  readStoredPerfSettings,
  updateStoredPerfSettings,
  type PerfDebugSnapshot,
} from '../shared/perf';

type Elements = {
  saveBtn: HTMLButtonElement | null;
  micBtn: HTMLButtonElement | null;
  startBtn: HTMLButtonElement | null;
  stopBtn: HTMLButtonElement | null;
  storageModeSelect: HTMLSelectElement | null;
  recordSelfVideoCheckbox: HTMLInputElement | null;
  selfVideoHighQualityCheckbox: HTMLInputElement | null;
  debugModeCheckbox: HTMLInputElement | null;
  debugMetricsEl: HTMLElement | null;
  recordingStatusEl: HTMLElement | null;
};

const UPLOADING_STATUS = 'Finalizing and saving files... you can close this popup.';

export class PopupController {
  private readonly el: Elements;
  private readonly mic = new MicPermissionService();
  private readonly camera = new CameraPermissionService();
  private inFlight = false;
  private lastPhase: RecordingPhase = 'idle';
  private shownUploadSummary = '';
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private debugPollTimer: ReturnType<typeof setInterval> | null = null;
  private persistentStatus = '';
  private activeRunConfig: RecordingRunConfig | null = null;

  constructor(el: Elements) {
    this.el = el;
  }

  init() {
    this.wireRecordingStateListener();
    this.wireTranscriptDownload();
    this.wireStartStop();
    this.wireMic();
    this.wireSelfVideoQualityToggle();
    this.wireDebugMode();
    void this.refreshInitialUi();
    void this.refreshDebugUi();
  }

  destroy() {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.stopDebugPolling();
  }

  private setUI(phase: RecordingPhase) {
    const {
      startBtn,
      stopBtn,
      storageModeSelect,
      recordSelfVideoCheckbox,
      selfVideoHighQualityCheckbox,
    } = this.el;

    if (!startBtn || !stopBtn) return;

    startBtn.disabled = phase !== 'idle';
    stopBtn.disabled = phase !== 'recording';

    const busy = phase !== 'idle';
    if (storageModeSelect) storageModeSelect.disabled = busy;
    if (recordSelfVideoCheckbox) recordSelfVideoCheckbox.disabled = busy;
    if (selfVideoHighQualityCheckbox) {
      selfVideoHighQualityCheckbox.disabled =
        busy || !recordSelfVideoCheckbox?.checked;
    }

    this.lastPhase = phase;
    this.syncPhaseStatus(phase);
  }

  private setStatus(text: string) {
    if (this.el.recordingStatusEl) this.el.recordingStatusEl.textContent = text;
  }

  private syncPhaseStatus(phase: RecordingPhase) {
    if (phase === 'idle') {
      this.persistentStatus = '';
    } else {
      const run = this.describeRunConfig(this.activeRunConfig);
      this.persistentStatus =
        phase === 'recording'
          ? `Recording in progress. ${run}`
          : `${UPLOADING_STATUS} ${run}`;
    }
    if (!this.statusTimer) {
      this.setStatus(this.persistentStatus);
    }
  }

  private describeRunConfig(config: RecordingRunConfig | null): string {
    if (!config) return '';
    const mode = config.storageMode === 'drive' ? 'Mode: Drive.' : 'Mode: Local.';
    const camera = config.recordSelfVideo
      ? config.selfVideoQuality === 'high'
        ? 'Camera: On (High quality).'
        : 'Camera: On (Standard quality).'
      : 'Camera: Off.';
    return `${mode} ${camera}`;
  }

  private parseRunConfig(raw: any): RecordingRunConfig | null {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.storageMode !== 'drive' && raw.storageMode !== 'local') return null;
    return {
      storageMode: raw.storageMode,
      recordSelfVideo: !!raw.recordSelfVideo,
      selfVideoQuality: raw.selfVideoQuality === 'high' ? 'high' : 'standard',
    };
  }

  private setActiveRunConfig(config: RecordingRunConfig | null) {
    this.activeRunConfig = config;
    if (!config) return;

    if (this.el.storageModeSelect) {
      this.el.storageModeSelect.value = config.storageMode;
    }
    if (this.el.recordSelfVideoCheckbox) {
      this.el.recordSelfVideoCheckbox.checked = config.recordSelfVideo;
    }
    if (this.el.selfVideoHighQualityCheckbox) {
      this.el.selfVideoHighQualityCheckbox.checked = config.selfVideoQuality === 'high';
    }
  }

  private toast(msg: string) {
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }

    this.setStatus(msg);
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.setStatus(this.persistentStatus);
    }, 12_000);

    console.log('[popup]', msg);
  }

  private async refreshInitialUi() {
    try {
      const st = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
      const phase = st?.phase === 'recording' || st?.phase === 'uploading' ? st.phase : 'idle';
      if (phase === 'idle') {
        this.setActiveRunConfig(null);
      } else {
        this.setActiveRunConfig(this.parseRunConfig(st?.runConfig));
      }
      this.setUI(phase);
    } catch {
      this.setActiveRunConfig(null);
      this.setUI('idle');
    }
  }

  private wireRecordingStateListener() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'RECORDING_STATE') {
        const prevPhase = this.lastPhase;
        const phase = msg.phase === 'recording' || msg.phase === 'uploading' ? msg.phase : 'idle';
        if (phase === 'idle') {
          this.setActiveRunConfig(null);
        } else {
          const runConfig = this.parseRunConfig(msg.runConfig);
          if (runConfig) this.setActiveRunConfig(runConfig);
        }
        this.setUI(phase);
        this.handleUploadSummary(prevPhase, phase, msg.uploadSummary as UploadSummary | undefined);
      }

      if (msg?.type === 'RECORDING_SAVED') {
        this.toast(`Saved locally: ${msg.filename || 'recording.webm'}`);
      }

      if (msg?.type === 'RECORDING_SAVE_ERROR') {
        const name = msg.filename || 'recording.webm';
        const error = msg.error || 'Unknown save error';
        this.toast(`Local save failed: ${name} (${error})`);
        alert(`Failed to save ${name} locally:\n${error}`);
      }
    });
  }

  private handleUploadSummary(
    prevPhase: RecordingPhase,
    phase: RecordingPhase,
    summary?: UploadSummary
  ) {
    if (phase !== 'idle' || !summary) return;

    const key = JSON.stringify(summary);
    if (this.shownUploadSummary === key) return;
    this.shownUploadSummary = key;

    if (summary.localFallbacks.length > 0) {
      const uploaded = summary.uploaded.map((x) => x.filename).join('\n') || '(none)';
      const fallback = summary.localFallbacks
        .map((x) => `${x.filename}${x.error ? `\n  ${x.error}` : ''}`)
        .join('\n\n');
      alert(
        'Drive upload completed with local fallback for some files.\n\n' +
        `Uploaded to Drive:\n${uploaded}\n\n` +
        `Saved locally instead:\n${fallback}`
      );
      return;
    }

    if (prevPhase === 'uploading' && summary.uploaded.length > 0) {
      this.toast(`Uploaded ${summary.uploaded.length} file(s) to Google Drive`);
    }
  }

  private wireMic() {
    if (!this.el.micBtn) return;
    this.mic.bindButton(this.el.micBtn);
  }

  private wireSelfVideoQualityToggle() {
    const { recordSelfVideoCheckbox, selfVideoHighQualityCheckbox } = this.el;
    if (!recordSelfVideoCheckbox || !selfVideoHighQualityCheckbox) return;

    const refresh = () => {
      if (!recordSelfVideoCheckbox.disabled) {
        selfVideoHighQualityCheckbox.disabled = !recordSelfVideoCheckbox.checked;
      }
    };

    recordSelfVideoCheckbox.addEventListener('change', refresh);
    refresh();
  }

  private async refreshDebugUi() {
    try {
      const settings = await readStoredPerfSettings();
      if (this.el.debugModeCheckbox) {
        this.el.debugModeCheckbox.checked = settings.debugMode;
      }
      if (settings.debugMode) {
        this.startDebugPolling();
      } else {
        this.stopDebugPolling();
        this.renderDebugSnapshot(undefined);
      }
    } catch {
      this.stopDebugPolling();
      this.renderDebugMessage('Debug metrics are unavailable.');
    }
  }

  private wireDebugMode() {
    const { debugModeCheckbox } = this.el;
    if (!debugModeCheckbox) return;

    debugModeCheckbox.addEventListener('change', async () => {
      const enabled = !!debugModeCheckbox.checked;
      debugModeCheckbox.disabled = true;
      try {
        const settings = await updateStoredPerfSettings({ debugMode: enabled });
        debugModeCheckbox.checked = settings.debugMode;
        if (settings.debugMode) {
          this.startDebugPolling();
          this.toast('Debug mode enabled');
        } else {
          this.stopDebugPolling();
          this.renderDebugSnapshot(undefined);
          this.toast('Debug mode disabled');
        }
      } catch (e: any) {
        debugModeCheckbox.checked = !enabled;
        this.renderDebugMessage('Failed to update debug mode.');
        alert(`Failed to update debug mode:\n${e?.message || e}`);
      } finally {
        debugModeCheckbox.disabled = false;
      }
    });
  }

  private startDebugPolling() {
    if (this.debugPollTimer) return;
    void this.refreshDebugSnapshot();
    this.debugPollTimer = setInterval(() => {
      void this.refreshDebugSnapshot();
    }, 1_000);
  }

  private stopDebugPolling() {
    if (!this.debugPollTimer) return;
    clearInterval(this.debugPollTimer);
    this.debugPollTimer = null;
  }

  private async refreshDebugSnapshot() {
    if (!this.el.debugMetricsEl) return;
    try {
      const res = await chrome.storage.session.get(PERF_DEBUG_SNAPSHOT_STORAGE_KEY);
      this.renderDebugSnapshot(res?.[PERF_DEBUG_SNAPSHOT_STORAGE_KEY] as PerfDebugSnapshot | undefined);
    } catch {
      this.renderDebugMessage('Debug metrics are unavailable.');
    }
  }

  private renderDebugSnapshot(snapshot?: PerfDebugSnapshot) {
    if (!this.el.debugMetricsEl) return;
    if (!this.el.debugModeCheckbox?.checked) {
      this.renderDebugMessage('Debug mode is off.');
      return;
    }
    if (!snapshot?.enabled) {
      this.renderDebugMessage('Waiting for debug metrics...');
      return;
    }

    const { summary } = snapshot;
    const recorderLatencies = ['tab', 'mic', 'selfVideo']
      .map((stream) => {
        const latency = summary.recorder.lastStartLatencyMsByStream[stream as 'tab' | 'mic' | 'selfVideo'];
        return latency == null ? null : `${stream}=${latency} ms`;
      })
      .filter(Boolean)
      .join(', ') || 'n/a';

    const recentEvents = snapshot.entries
      .slice(-6)
      .map((entry) => {
        const time = new Date(entry.ts).toLocaleTimeString();
        const payload = Object.keys(entry.fields).length ? ` ${JSON.stringify(entry.fields)}` : '';
        return `${time} ${entry.source}:${entry.scope}:${entry.event}${payload}`;
      })
      .join('\n');

    this.el.debugMetricsEl.textContent = [
      `Debug mode: on`,
      `Phase: ${summary.currentPhase}`,
      `Events: ${summary.totalEvents} (${snapshot.droppedEvents} dropped from buffer)`,
      `Flags: audioBridge=${snapshot.settings.audioPlaybackBridgeMode}, adaptiveSelfVideo=${snapshot.settings.adaptiveSelfVideoProfile ? 'on' : 'off'}, extendedTimeslice=${snapshot.settings.extendedTimeslice ? 'on' : 'off'}, dynamicChunks=${snapshot.settings.dynamicDriveChunkSizing ? 'on' : 'off'}, parallelUploads=${snapshot.settings.parallelUploadConcurrency}`,
      `Recorder: active=${summary.runtime.activeRecorders}, timeslice=${summary.recorder.lastTimesliceMs ?? 'n/a'} ms, startLatency=${recorderLatencies}`,
      `Recorder chunks: count=${summary.recorder.persistedChunkCount}, size=${this.formatBytes(summary.recorder.persistedChunkBytes)}, avgWrite=${this.formatMs(summary.recorder.avgPersistedChunkDurationMs)}`,
      `Audio bridge: mode=${summary.recorder.lastAudioBridgeMode ?? 'n/a'}, suppressed=${this.formatBool(summary.recorder.lastAudioBridgeSuppressed)}, enabled=${this.formatBool(summary.recorder.lastAudioBridgeEnabled)}`,
      `Self video bitrate: ${this.formatBitrate(summary.recorder.lastSelfVideoBitrate)}`,
      `Captions: currentObservers=${summary.captions.currentObserverCount}, maxObservers=${summary.captions.maxObserverCount}`,
      `Upload: chunks=${summary.upload.chunkCount}, retries=${summary.upload.retryCount}, avgChunk=${this.formatMs(summary.upload.avgChunkDurationMs)}, lastThroughput=${this.formatRate(summary.upload.lastChunkThroughputMbps)}`,
      `Uploads done: files=${summary.upload.fileCount}, uploaded=${summary.upload.uploadedCount}, fallbacks=${summary.upload.fallbackCount}, avgFile=${this.formatMs(summary.upload.avgFileDurationMs)}, concurrency=${summary.upload.lastConcurrency ?? 'n/a'}, fallbackRate=${summary.upload.lastFallbackRate ?? 'n/a'}`,
      `Runtime: state=${summary.runtime.state}, heap=${this.formatHeap(summary.runtime.lastHeapUsedMb, summary.runtime.lastHeapLimitMb)}, maxHeap=${summary.runtime.maxHeapUsedMb ?? 'n/a'} MB`,
      `Recent events:`,
      recentEvents || '(none yet)',
    ].join('\n');
  }

  private renderDebugMessage(message: string) {
    if (this.el.debugMetricsEl) this.el.debugMetricsEl.textContent = message;
  }

  private formatBool(value: boolean | null): string {
    return value == null ? 'n/a' : value ? 'yes' : 'no';
  }

  private formatMs(value: number | null): string {
    return value == null ? 'n/a' : `${value} ms`;
  }

  private formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    if (value >= 1024 * 1024) return `${Math.round((value / 1024 / 1024) * 10) / 10} MB`;
    if (value >= 1024) return `${Math.round((value / 1024) * 10) / 10} KB`;
    return `${value} B`;
  }

  private formatBitrate(value: number | null): string {
    return value == null ? 'n/a' : `${Math.round((value / 1_000_000) * 100) / 100} Mbps`;
  }

  private formatRate(value: number | null): string {
    return value == null ? 'n/a' : `${value} MB/s`;
  }

  private formatHeap(used: number | null, limit: number | null): string {
    if (used == null) return 'n/a';
    if (limit == null) return `${used} MB`;
    return `${used} / ${limit} MB`;
  }

  private wireTranscriptDownload() {
    const { saveBtn } = this.el;
    if (!saveBtn) return;

    saveBtn.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;

      const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TRANSCRIPT' }).catch(() => {
        this.toast('No transcript on this page');
        return undefined;
      });

      const transcript = (res as any)?.transcript as string | undefined;
      if (!transcript?.trim()) {
        this.toast('Transcript is empty');
        return;
      }

      const blob = new Blob([transcript], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const suffix =
        new URL(tab.url ?? 'https://meet.google.com').pathname.split('/').pop() || 'google-meet';

      chrome.downloads.download(
        { url, filename: `google-meet-transcript-${suffix}-${Date.now()}.txt`, saveAs: true },
        () => URL.revokeObjectURL(url)
      );
    });
  }

  private wireStartStop() {
    const { startBtn, stopBtn } = this.el;
    if (!startBtn || !stopBtn) return;

    startBtn.addEventListener('click', async () => {
      if (this.inFlight) return;
      this.inFlight = true;
      startBtn.disabled = true;

      try {
        await this.mic.ensurePrimedBestEffort();

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) throw new Error('No active tab');

        await chrome.tabs.sendMessage(tab.id, { type: 'RESET_TRANSCRIPT' }).catch(() => {});

        const storageMode = this.el.storageModeSelect?.value === 'drive' ? 'drive' : 'local';
        const recordSelfVideo = !!this.el.recordSelfVideoCheckbox?.checked;
        const selfVideoQuality =
          recordSelfVideo && this.el.selfVideoHighQualityCheckbox?.checked ? 'high' : 'standard';
        const runConfig: RecordingRunConfig = {
          storageMode,
          recordSelfVideo,
          selfVideoQuality,
        };

        if (recordSelfVideo) {
          const cameraReady = await this.camera.ensureReadyForRecording();
          if (!cameraReady) {
            throw new Error(
              'Camera permission is required for "Record my camera separately". ' +
              'A setup tab was opened. Enable camera there and start again.'
            );
          }
        }

        const resp = await chrome.runtime.sendMessage({
          type: 'START_RECORDING',
          tabId: tab.id,
          storageMode,
          recordSelfVideo,
          selfVideoQuality,
        });
        if (!resp) throw new Error('No response from background');
        if (resp.ok === false) throw new Error(resp.error || 'Failed to start');

        this.setActiveRunConfig(runConfig);
        this.setUI('recording');
        this.toast('Recording started');
      } catch (e: any) {
        console.error('[popup] START_RECORDING error', e);
        this.setActiveRunConfig(null);
        this.setUI('idle');
        alert(`Failed to start recording:\n${e?.message || e}`);
      } finally {
        this.inFlight = false;
      }
    });

    stopBtn.addEventListener('click', async () => {
      if (this.inFlight) return;
      this.inFlight = true;
      stopBtn.disabled = true;

      try {
        const resp = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
        if (!resp) throw new Error('No response from background');
        if (resp.ok === false) throw new Error(resp.error || 'Failed to stop');
        this.toast('Stopping... finalizing local files. You can close this popup.');
      } catch (e: any) {
        console.error('[popup] STOP_RECORDING error', e);
        alert(`Failed to stop recording:\n${e?.message || e}`);
        this.setUI('idle');
      } finally {
        this.inFlight = false;
      }
    });
  }
}
