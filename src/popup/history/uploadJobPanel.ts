/**
 * @file popup/history/uploadJobPanel.ts
 *
 * The saved/uploading panel for one Drive upload job (ADR-0004): the progress
 * bar or the saved confirmation, the file list, the notes line, and which of
 * the retry/cancel/open actions apply.
 *
 * A pure paint over the popup's element map — it decides nothing and sends
 * nothing, so the same function serves a live upload and a gallery fixture.
 *
 * The notes sidecar is deliberately not one of the media files: it gets its own
 * line (d4) and stays out of the counts and the size, which describe the media
 * being uploaded.
 */

import { createExternalTab } from '../../platform/chrome/tabs';
import { formatBytes } from '../../shared/format';
import type { PopupElements } from '../popupView';
import type { RecordingStream, UploadJob, UploadJobFile } from '../../shared/recording';

/** Headline status line for an upload job's view. */
function uploadJobStatusText(job: UploadJob): string {
  if (job.recoveryPending) {
    return job.status === 'partial'
      ? 'Partially uploaded — remaining files retry when the recorder starts'
      : 'Upload paused — retrying when the recorder starts';
  }
  if (job.files.some((file) => file.status === 'unavailable')) {
    return job.status === 'partial'
      ? 'Partially uploaded — some recovery sources are unavailable'
      : 'Upload failed — recovery source is unavailable';
  }
  switch (job.status) {
    case 'completed': return 'Recording saved';
    case 'partial': return 'Uploaded — some files saved locally';
    case 'failed': return 'Upload failed — saved locally';
    case 'canceled': return 'Upload canceled — saved locally';
    default: return 'Uploading to Google Drive…';
  }
}

/** Per-file outcome label inside an upload job's view. */
function uploadFileStatusText(file: UploadJobFile): string {
  if (file.status === 'uploaded') return 'Uploaded';
  if (file.status === 'fallback') return 'Saved locally';
  if (file.status === 'retry-pending') return 'Retry pending';
  if (file.status === 'unavailable') return file.error || 'Recovery source unavailable';
  return 'Uploading…';
}

function fileCountText(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

function driveFileUrl(file: UploadJobFile): string | undefined {
  if (file.webViewLink) return file.webViewLink;
  return file.driveFileId ? `https://drive.google.com/file/d/${encodeURIComponent(file.driveFileId)}/view` : undefined;
}

function svgPathForStream(stream: RecordingStream): string {
  if (stream === 'mic') {
    return 'M8 10a2 2 0 002-2V4a2 2 0 00-4 0v4a2 2 0 002 2zM4.5 8a.5.5 0 00-1 0 4.5 4.5 0 009 0 .5.5 0 00-1 0 3.5 3.5 0 01-7 0zM7.5 13.5v1.5h1v-1.5a.5.5 0 00-1 0z';
  }
  if (stream === 'self-video') {
    return 'M2 4.5A1.5 1.5 0 013.5 3h6A1.5 1.5 0 0111 4.5v1.2l3.2-1.8a.5.5 0 01.8.4v7.4a.5.5 0 01-.8.4L11 10.3v1.2A1.5 1.5 0 019.5 13h-6A1.5 1.5 0 012 11.5v-7z';
  }
  return 'M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v7A1.5 1.5 0 0112.5 12H9v1h2v1H5v-1h2v-1H3.5A1.5 1.5 0 012 10.5v-7z';
}

function buildStreamIcon(stream: RecordingStream): HTMLElement {
  const icon = document.createElement('span');
  icon.className = 'file-ico';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', svgPathForStream(stream));
  svg.appendChild(path);
  icon.appendChild(svg);
  return icon;
}

export function renderUploadJobPanel(
  el: Partial<PopupElements>,
  job: UploadJob,
  onRendered?: (job: UploadJob) => void,
): void {
  const percent = Math.round(Math.min(1, Math.max(0, job.progress)) * 100);
  const completed = job.status === 'completed';
  // The notes sidecar is delivered with the recording but is not one of its
  // media files: it gets its own line (d4) and is left out of the counts and
  // the size, which describe what is being uploaded.
  const notesFile = job.files.find((file) => file.kind === 'notes');
  const mediaFiles = job.files.filter((file) => file.kind !== 'notes');
  const totalBytes = mediaFiles.reduce((sum, f) => sum + (typeof f.bytes === 'number' ? f.bytes : 0), 0);
  const sizeSuffix = totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : '';

  // Toggle the in-progress bar vs. the saved-confirmation block.
  if (el.uploadProgress) el.uploadProgress.hidden = completed;
  if (el.uploadDone) el.uploadDone.hidden = !completed;

  // In-progress bar (the head text also carries failed/partial outcomes).
  if (el.uploadJobLabel) {
    el.uploadJobLabel.textContent = job.status === 'uploading'
      ? 'to Google Drive'
      : uploadJobStatusText(job);
  }
  if (el.uploadJobPct) el.uploadJobPct.textContent = `${percent}%`;
  if (el.uploadBarFill) el.uploadBarFill.style.width = `${percent}%`;
  if (el.uploadJobMeta) {
    el.uploadJobMeta.textContent = fileCountText(mediaFiles.length);
  }

  // Saved-confirmation subline (shown in the done block).
  if (el.uploadJobSub) {
    el.uploadJobSub.textContent = `${fileCountText(mediaFiles.length)}${sizeSuffix} · Google Drive`;
  }
  renderNotesLine(el, notesFile);
  onRendered?.(job);
  if (el.uploadJobFiles) {
    const frag = document.createDocumentFragment();
    for (const file of mediaFiles) {
      const li = document.createElement('li');
      li.classList.add(`file-status-${file.status}`);
      li.appendChild(buildStreamIcon(file.stream));
      const main = document.createElement('div');
      main.className = 'file-main';
      const name = document.createElement('div');
      name.className = 'file-title';
      name.textContent = file.filename;
      const status = document.createElement('div');
      status.className = 'file-sub';
      if (file.status === 'uploaded' && completed) {
        status.textContent = typeof file.bytes === 'number' ? formatBytes(file.bytes) : 'DONE';
      } else if (file.status === 'uploaded') {
        status.textContent = `✓ DONE${typeof file.bytes === 'number' ? ` · ${formatBytes(file.bytes)}` : ''}`;
      } else if (typeof file.bytes === 'number') {
        status.textContent = `${formatBytes(Math.round(file.bytes * job.progress))} / ${formatBytes(file.bytes)}`;
      } else {
        status.textContent = uploadFileStatusText(file);
      }
      const head = document.createElement('div');
      head.className = 'file-head';
      head.append(name, status);
      main.append(head);
      if (job.status === 'uploading' || file.status === 'uploaded') {
        const progress = document.createElement('div');
        progress.className = 'file-progress';
        const fill = document.createElement('span');
        const fraction = file.status === 'uploaded' ? 1 : job.progress;
        fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
        progress.append(fill);
        main.append(progress);
      }
      const openUrl = driveFileUrl(file);
      if (openUrl && file.status === 'uploaded') {
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'file-open';
        open.textContent = '↗';
        open.addEventListener('click', () => void createExternalTab(openUrl));
        head.appendChild(open);
      }
      li.appendChild(main);
      frag.appendChild(li);
    }
    el.uploadJobFiles.replaceChildren(frag);
  }
  // Retry is offered only for a job that ended with fallbacks.
  if (el.uploadJobRetry) {
    el.uploadJobRetry.hidden = job.recoveryPending
      || job.files.some((file) => file.status === 'unavailable')
      || !(job.status === 'failed' || job.status === 'partial');
    el.uploadJobRetry.dataset.jobId = job.id;
  }
  if (el.uploadJobCancel) {
    el.uploadJobCancel.hidden = job.status !== 'uploading';
    el.uploadJobCancel.disabled = false;
    el.uploadJobCancel.dataset.jobId = job.id;
  }
  if (el.uploadJobOpenDrive) {
    el.uploadJobOpenDrive.hidden = !(completed && job.folderWebViewLink);
    el.uploadJobOpenDrive.dataset.folderUrl = completed ? job.folderWebViewLink ?? '' : '';
  }
  const newRecording = document.getElementById('upload-job-new-recording') as HTMLButtonElement | null;
  // An upload is intentionally backgroundable: the user can immediately return
  // to Setup and start another recording without cancelling the current job.
  if (newRecording) newRecording.hidden = false;
  const transcript = document.getElementById('upload-job-transcript') as HTMLButtonElement | null;
  if (transcript) transcript.hidden = !completed;
}

/**
   * The notes line (d4): says the sidecar went up, and that it went first.
   * Hidden entirely for a recording with no notes.
   */
function renderNotesLine(el: Partial<PopupElements>, notesFile: UploadJobFile | undefined): void {
  const row = el.uploadJobNotesLine;
  if (!row) return;
  row.hidden = !notesFile;
  if (!notesFile) return;
  const uploaded = notesFile.status === 'uploaded';
  if (el.uploadJobNotesState) {
    el.uploadJobNotesState.textContent = uploaded ? 'SAVED FIRST' : 'SAVING FIRST';
  }
  row.classList.toggle('upload-notes--saved', uploaded);
}
