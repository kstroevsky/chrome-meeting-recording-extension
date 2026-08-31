/**
 * @file popup/PopupStatusView.ts
 *
 * Everything the popup says about the run *outside* the screen it is on: the
 * header's phase label and tone, the REC banner, the storage and tab-source
 * chips, the finalizing checklist, and the header's one-tap return to an
 * upload still in flight.
 *
 * These share a rule worth keeping in one place: the header speaks only when no
 * louder surface already does. Sealing is quiet because the finalizing screen
 * owns that status, and an active upload is represented by the progress control
 * rather than a second label beside it.
 */

import { detailPercent } from './historyChrome';
import type { PopupElements } from './popupView';
import type { RecordingPhase, RecordingStatusView } from '../shared/recording';

export type PopupStatusElements = Pick<
  PopupElements,
  | 'ppHeader'
  | 'recLabel'
  | 'recBanner'
  | 'chipStorageLabel'
  | 'tabSourceSub'
  | 'finalizingLabel'
  | 'finalizingSub'
  | 'finalizingFiles'
  | 'uploadRing'
  | 'uploadRingArc'
  | 'uploadRingLabel'
>;

/** Joins labels as "a", "a & b", or "a, b & c". */
export function humanJoin(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}`;
}

export class PopupStatusView {
  private readonly el: Partial<PopupStatusElements>;

  constructor(el: Partial<PopupStatusElements> | null | undefined) {
    this.el = el ?? {};
  }

  /** Full wordmark header on the idle/config screen; compact header everywhere else. */
  setHeaderCompact(compact: boolean): void {
    this.el.ppHeader?.classList.toggle('compact', compact);
  }

  /** Mirrors the reference design's compact status label beside the wordmark. */
  syncHeaderPhase(phase: RecordingPhase, paused: boolean): void {
    const label = document.getElementById('header-phase');
    if (!label) return;
    const active = phase === 'starting' || phase === 'recording' || phase === 'stopping';
    const uploadNavigationVisible = !document.getElementById('open-upload-navigation')?.hidden;
    // Sealing is deliberately quiet: the finalizing screen owns the status, while
    // an in-flight upload is represented by the compact progress control instead.
    label.hidden = uploadNavigationVisible || !active || phase === 'stopping';
    label.textContent = paused ? 'PAUSED' : phase === 'stopping' ? 'SAVING' : 'REC';
    label.dataset.tone = paused ? 'paused' : 'recording';
    this.el.ppHeader?.classList.toggle('recording-active', active && !paused);
    this.el.ppHeader?.classList.toggle('recording-paused', active && paused);
    this.el.ppHeader?.classList.remove('recording-saved');
    this.el.ppHeader?.classList.remove('permission-blocked');
  }

  /** Updates the header tone while a detached upload detail is visible. */
  syncHeaderUpload(completed: boolean): void {
    const label = document.getElementById('header-phase');
    if (!label) return;
    label.hidden = true;
    this.el.ppHeader?.classList.toggle('recording-active', !completed);
    this.el.ppHeader?.classList.remove('recording-paused');
    this.el.ppHeader?.classList.toggle('recording-saved', completed);
  }

  /** Header-level one-tap return to the latest in-flight upload. */
  syncUploadNavigation(session?: RecordingStatusView): void {
    const button = document.getElementById('open-upload-navigation') as HTMLButtonElement | null;
    const ring = document.getElementById('upload-navigation-ring');
    const percentLabel = document.getElementById('upload-navigation-percent');
    if (!button || !ring || !percentLabel) return;
    const uploadingJobs = (session?.uploadJobs ?? []).filter((candidate) => candidate.status === 'uploading');
    const job = uploadingJobs[uploadingJobs.length - 1];
    button.hidden = !job;
    if (!job) {
      button.dataset.jobId = '';
      return;
    }
    const percent = detailPercent(job.progress);
    button.dataset.jobId = job.id;
    button.title = `Open upload progress (${percent}%)`;
    button.setAttribute('aria-label', `Open upload progress, ${percent}% complete`);
    ring.style.setProperty('--upload-progress', String(percent));
    percentLabel.textContent = `${percent}%`;
  }

  /** Sets the recording banner label + paused styling for the current phase. */
  syncRecordingBanner(phase: RecordingPhase, session?: RecordingStatusView): void {
    const paused = phase === 'recording' && session?.paused === true;
    const starting = phase === 'starting';
    if (this.el.recLabel) {
      this.el.recLabel.textContent = starting ? 'Starting…' : paused ? 'Paused' : 'REC';
    }
    if (this.el.recBanner) this.el.recBanner.classList.toggle('paused', paused);
  }

  /** Renders the storage chip from the run config (the transcript chip is poll-driven). */
  syncChips(session?: RecordingStatusView): void {
    if (this.el.chipStorageLabel) {
      this.el.chipStorageLabel.textContent =
        session?.runConfig?.storageMode === 'drive' ? 'Google Drive' : 'Local Disk';
    }
  }

  syncTabSource(session?: RecordingStatusView): void {
    if (!this.el.tabSourceSub) return;
    const contentType = session?.runConfig?.tabContentType === 'video' ? 'Video' : 'Screen';
    const height = session?.tabResolution?.height;
    this.el.tabSourceSub.textContent =
      typeof height === 'number' && height > 0 ? `${contentType} · ${Math.round(height)}p` : contentType;
  }

  /** Populates the finalizing view: spinner + a per-stream checklist of what's being sealed. */
  syncFinalizing(session?: RecordingStatusView): void {
    if (this.el.finalizingLabel) this.el.finalizingLabel.textContent = 'Finalizing recording';
    this.syncUploadRing();
    const cfg = session?.runConfig;
    // The real output files this run produces: the tab always; a separate mic file
    // only in 'separate' mode; a camera file only when recording it separately.
    const sources: string[] = ['Meeting tab'];
    if (cfg?.micMode === 'separate') sources.push('Microphone');
    if (cfg?.recordSelfVideo) sources.push('Camera');

    if (this.el.finalizingSub) {
      const shorts = sources.map((s) => (s === 'Meeting tab' ? 'tab' : s === 'Microphone' ? 'mic' : 'camera'));
      this.el.finalizingSub.textContent = `Muxing ${humanJoin(shorts)}`;
    }
    if (this.el.finalizingFiles) {
      const frag = document.createDocumentFragment();
      for (const label of sources) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.textContent = label;
        const spin = document.createElement('span');
        spin.className = 'file-spin';
        li.append(name, spin);
        frag.appendChild(li);
      }
      this.el.finalizingFiles.replaceChildren(frag);
    }
  }

  /**
   * The finalizing view only appears while `stopping` (sealing files), which has
   * no measurable progress, so its ring is always the indeterminate spinner. Live
   * Drive-upload progress lives in the per-job upload tabs (ADR-0004).
   */
  private syncUploadRing(): void {
    const ring = this.el.uploadRing;
    if (!ring) return;
    ring.dataset.mode = 'indeterminate';
    if (this.el.uploadRingArc) this.el.uploadRingArc.style.strokeDashoffset = '100';
    if (this.el.uploadRingLabel) this.el.uploadRingLabel.textContent = '';
  }
}
