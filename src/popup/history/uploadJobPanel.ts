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
import type { UploadJob, UploadJobFile } from '../../shared/recording';

/** Which of the screen's four states a job is in (d4, n2a, 8A, 8C). */
export type UploadPanelState = 'uploading' | 'saved' | 'failed' | 'partial';

export function uploadPanelState(job: UploadJob): UploadPanelState {
  if (job.status === 'uploading') return 'uploading';
  if (job.status === 'completed') return 'saved';
  return job.status === 'partial' ? 'partial' : 'failed';
}

/** A file that did not reach Drive: it fell back, is waiting on a retry, or lost its source. */
function missedDrive(file: UploadJobFile): boolean {
  return file.status === 'fallback' || file.status === 'retry-pending' || file.status === 'unavailable';
}

/** The line a job that did not fully land leads with (8A, 8C). */
function outcomeText(job: UploadJob, media: UploadJobFile[]): string {
  const missed = media.filter(missedDrive).length;
  if (job.recoveryPending) return 'UPLOAD PAUSED · RETRIES WHEN THE RECORDER STARTS';
  if (job.status === 'canceled') return 'UPLOAD CANCELED · KEPT ON THIS DEVICE';
  if (media.some((file) => file.status === 'unavailable')) return 'UPLOAD FAILED · RECOVERY SOURCE UNAVAILABLE';
  if (job.status === 'partial') return `SAVED WITH ${missed} ${missed === 1 ? 'PROBLEM' : 'PROBLEMS'}`;
  const landed = media.length - missed;
  return `SAVING · STOPPED AT ${Math.min(media.length, landed + 1)} OF ${media.length}`;
}

/** Why a file is not in Drive, in the words of the row that says so (8A). */
function missedReason(file: UploadJobFile): string {
  if (file.status === 'unavailable') return file.error || 'The recording source is no longer available.';
  if (file.status === 'retry-pending') return 'Retries when the recorder starts. The file is still on this device.';
  return 'Drive rejected the upload. Nothing was lost — the file is still on this device.';
}

function fileCountText(count: number): string {
  return `${count} ${count === 1 ? 'FILE' : 'FILES'}`;
}

function driveFileUrl(file: UploadJobFile): string | undefined {
  if (file.webViewLink) return file.webViewLink;
  return file.driveFileId ? `https://drive.google.com/file/d/${encodeURIComponent(file.driveFileId)}/view` : undefined;
}

const OPEN_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4h6v6M11.5 4.5L5 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function openButton(file: UploadJobFile, url: string): HTMLButtonElement {
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'up-file-open';
  open.title = `Open ${file.filename} in Google Drive`;
  open.setAttribute('aria-label', open.title);
  open.innerHTML = OPEN_ICON;
  open.addEventListener('click', () => void createExternalTab(url));
  return open;
}

function textSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function bar(fraction: number, tone: 'ink' | 'saved' | 'failed'): HTMLElement {
  const track = document.createElement('div');
  track.className = `up-bar up-bar--${tone}`;
  const fill = document.createElement('span');
  fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  track.append(fill);
  return track;
}

/** d4: every file with its own state — saved, moving, or waiting its turn. */
export function uploadingRow(file: UploadJobFile): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'up-file up-file--progress';
  const head = document.createElement('div');
  head.className = 'up-file-head';
  let state: string;
  let fraction = 0;
  let tone: 'ink' | 'saved' = 'ink';
  if (file.status === 'uploaded') {
    state = 'SAVED';
    fraction = 1;
    tone = 'saved';
    li.classList.add('up-file--saved');
  } else if (file.uploadedBytes && file.bytes) {
    fraction = file.uploadedBytes / file.bytes;
    state = `UPLOADING ${Math.min(99, Math.floor(fraction * 100))}%`;
  } else {
    state = 'QUEUED';
  }
  head.append(textSpan('up-file-name', file.filename), textSpan('up-file-state', state));
  li.append(head, bar(fraction, tone));
  return li;
}

/** n2a: what is in Drive now, its size, and a way to open it. */
function savedRow(file: UploadJobFile): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'up-file up-file--saved-row';
  const meta = document.createElement('span');
  meta.className = 'up-file-meta';
  if (typeof file.bytes === 'number') meta.append(textSpan('up-file-size', formatBytes(file.bytes)));
  const url = driveFileUrl(file);
  if (url) meta.append(openButton(file, url));
  li.append(textSpan('up-file-name', file.filename), meta);
  return li;
}

/** 8A: DONE or FAILED per file, and why a failed one is still safe. */
function failedRow(file: UploadJobFile): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'up-file up-file--outcome';
  const head = document.createElement('div');
  head.className = 'up-file-head';
  const missed = missedDrive(file);
  // A retained file waiting on the recorder is not a failure yet: it WAITS (8A).
  const waiting = file.status === 'retry-pending';
  li.classList.add(waiting ? 'up-file--waiting' : missed ? 'up-file--failed' : 'up-file--done');
  head.append(textSpan('up-file-name', file.filename), textSpan('up-file-state', waiting ? 'WAITING' : missed ? 'FAILED' : 'DONE'));
  li.append(head, bar(waiting ? 0 : 1, missed ? 'failed' : 'saved'));
  if (missed) li.append(textSpan('up-file-reason', missedReason(file)));
  return li;
}

/** 8C: each file says where it is; a sole failure offers its retry in place. */
function partialRow(file: UploadJobFile, retry: HTMLButtonElement | null | undefined, soleFailure: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'up-file up-file--partial';
  const text = document.createElement('div');
  text.className = 'up-file-text';
  const missed = missedDrive(file);
  const size = typeof file.bytes === 'number' ? `${formatBytes(file.bytes)} · ` : '';
  if (missed) li.classList.add('up-file--failed');
  text.append(textSpan('up-file-name', file.filename), textSpan('up-file-sub', `${size.toUpperCase()}${missed ? 'FAILED' : 'IN DRIVE'}`));
  li.append(text);
  const url = driveFileUrl(file);
  if (!missed && url) li.append(openButton(file, url));
  if (missed && soleFailure && retry && !retry.hidden) {
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'up-file-retry';
    again.textContent = 'Retry';
    again.addEventListener('click', () => retry.click());
    li.append(again);
  }
  return li;
}

/** "Retry the audio file" for one failure, "Retry 2 files" for more (8C). */
function partialRetryLabel(missed: UploadJobFile[]): string {
  if (missed.length !== 1) return `Retry ${missed.length} files`;
  const noun = missed[0].stream === 'mic' ? 'audio' : missed[0].stream === 'self-video' ? 'camera' : 'video';
  return `Retry the ${noun} file`;
}

function shareableNote(landed: number): string {
  if (landed === 1) return 'The file above is already shareable.';
  return `The ${landed === 2 ? 'two' : landed} files above are already shareable.`;
}

export function renderUploadJobPanel(
  el: Partial<PopupElements>,
  job: UploadJob,
  onRendered?: (job: UploadJob) => void,
): void {
  const state = uploadPanelState(job);
  // The notes sidecar is delivered with the recording but is not one of its
  // media files: it gets its own line (d4) and is left out of the counts and
  // the size, which describe what is being uploaded.
  const notesFile = job.files.find((file) => file.kind === 'notes');
  const mediaFiles = job.files.filter((file) => file.kind !== 'notes');
  const missed = mediaFiles.filter(missedDrive);
  const totalBytes = mediaFiles.reduce((sum, f) => sum + (typeof f.bytes === 'number' ? f.bytes : 0), 0);
  if (el.viewUpload) el.viewUpload.dataset.state = state;

  const leadsWithHead = state === 'uploading' || state === 'saved';
  if (el.uploadHead) el.uploadHead.hidden = !leadsWithHead;
  if (el.uploadEyebrow) {
    el.uploadEyebrow.hidden = leadsWithHead;
    el.uploadEyebrow.textContent = leadsWithHead ? '' : outcomeText(job, mediaFiles);
  }
  if (el.uploadJobLabel) el.uploadJobLabel.textContent = state === 'saved' ? 'Recording saved' : 'Uploading to Drive';
  if (el.uploadJobSub) {
    const landed = mediaFiles.filter((file) => file.status === 'uploaded').length;
    const base = state === 'uploading'
      ? `${landed} OF ${fileCountText(mediaFiles.length)}`
      : `${fileCountText(mediaFiles.length)}${totalBytes > 0 ? ` · ${formatBytes(totalBytes).toUpperCase()}` : ''}`;
    // The caller extends this with what it learns later (length, notes); the
    // base is kept so a repaint never appends twice.
    el.uploadJobSub.dataset.base = base;
    el.uploadJobSub.textContent = base;
  }
  if (el.uploadFilesLabel) {
    el.uploadFilesLabel.hidden = !leadsWithHead;
    el.uploadFilesLabel.textContent = state === 'saved' ? 'IN GOOGLE DRIVE' : 'PROGRESS';
  }

  renderNotesLine(el, notesFile, state);
  onRendered?.(job);

  // Retry is offered only for a job that ended with fallbacks it can still re-send.
  if (el.uploadJobRetry) {
    el.uploadJobRetry.hidden = job.recoveryPending === true
      || job.files.some((file) => file.status === 'unavailable')
      || !(job.status === 'failed' || job.status === 'partial');
    el.uploadJobRetry.dataset.jobId = job.id;
    el.uploadJobRetry.textContent = state === 'partial' ? partialRetryLabel(missed) : 'Retry upload';
  }
  if (el.uploadJobFiles) {
    const frag = document.createDocumentFragment();
    for (const file of mediaFiles) {
      if (state === 'uploading') frag.append(uploadingRow(file));
      else if (state === 'saved') frag.append(savedRow(file));
      else if (state === 'partial') frag.append(partialRow(file, el.uploadJobRetry, missed.length === 1));
      else frag.append(failedRow(file));
    }
    el.uploadJobFiles.replaceChildren(frag);
  }
  // Cancelling is a menu action: the saving screen keeps its one button (d4).
  if (el.uploadJobCancel) {
    el.uploadJobCancel.hidden = job.status !== 'uploading';
    el.uploadJobCancel.disabled = false;
    el.uploadJobCancel.dataset.jobId = job.id;
  }
  // Saved: the screen's primary. Partial: the way to the files that did land (8C).
  const drive = (state === 'saved' || state === 'partial') && job.folderWebViewLink ? job.folderWebViewLink : '';
  if (el.uploadJobOpenDrive) {
    el.uploadJobOpenDrive.hidden = !drive;
    el.uploadJobOpenDrive.dataset.folderUrl = drive;
  }
  if (el.uploadJobOpenDriveLabel) {
    el.uploadJobOpenDriveLabel.textContent = state === 'partial' ? 'Open what landed in Drive' : 'Open in Google Drive';
  }
  // An upload is intentionally backgroundable: the user can immediately return
  // to Setup and start another recording without cancelling the current job.
  // A partial job with its Drive link has that link as its second action instead.
  if (el.uploadJobNewRecording) {
    el.uploadJobNewRecording.hidden = state === 'partial' && Boolean(drive);
    el.uploadJobNewRecording.textContent = state === 'uploading'
      ? 'Keep uploading in background'
      : state === 'saved' ? 'New recording' : 'Retry later';
  }
  if (el.uploadRecoveryNote) {
    el.uploadRecoveryNote.hidden = leadsWithHead;
    el.uploadRecoveryNote.textContent = state === 'partial'
      ? shareableNote(mediaFiles.length - missed.length)
      : 'Files stay on this device until they land in Drive.';
  }
  const transcript = document.getElementById('upload-job-transcript') as HTMLButtonElement | null;
  if (transcript) transcript.hidden = state !== 'saved';
}

/**
 * The notes line (d4): says the sidecar went up, and that it went first.
 * Shown only while uploading — once saved, the notes section itself takes over.
 */
function renderNotesLine(el: Partial<PopupElements>, notesFile: UploadJobFile | undefined, state: UploadPanelState): void {
  const row = el.uploadJobNotesLine;
  if (!row) return;
  row.hidden = !notesFile || state !== 'uploading';
  if (!notesFile) return;
  const uploaded = notesFile.status === 'uploaded';
  if (el.uploadJobNotesState) {
    el.uploadJobNotesState.textContent = uploaded ? 'SAVED FIRST' : 'SAVING FIRST';
  }
  row.classList.toggle('upload-notes--saved', uploaded);
}
