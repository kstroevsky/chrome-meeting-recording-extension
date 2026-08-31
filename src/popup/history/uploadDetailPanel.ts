/**
 * @file popup/history/uploadDetailPanel.ts
 *
 * The detail screen for an upload still in flight: overall progress, then each
 * file's own bar.
 *
 * A file that has finished shows DONE and a full bar rather than the job's
 * percentage, because a Drive upload completes its files in order — showing the
 * job's figure on an already-uploaded file would read as if it had stalled.
 */

import { detailPercent, recordingDetailDate } from './historyChrome';
import { formatBytes } from '../../shared/format';
import type { UploadJob } from '../../shared/recording';

const DONE_MARK = '<svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3 7.2l2.6 2.6L11 4.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>DONE';

export function renderUploadDetail(
content: HTMLElement,
job: UploadJob,
onCancel: (job: UploadJob, button: HTMLButtonElement) => void,
): void {
  const title = document.createElement('h2');
  title.className = 'recording-detail-title';
  title.style.marginTop = '16px';
  title.textContent = job.label;
  title.title = job.label;
  const meta = document.createElement('p');
  meta.className = 'recording-detail-meta';
  meta.style.marginTop = '4px';
  meta.style.marginBottom = '16px';
  meta.textContent = `${recordingDetailDate(job.startedAt)} · ${job.status === 'uploading' ? 'UPLOADING' : job.status.toUpperCase()}`;
  const progress = document.createElement('div');
  progress.className = 'recording-detail-upload-progress';
  const percent = detailPercent(job.progress);
  progress.innerHTML = `<span class="recording-detail-upload-percent">${percent}%</span><span class="recording-detail-upload-label">to Google Drive</span>`;
  const track = document.createElement('div');
  track.className = 'recording-detail-progress';
  const fill = document.createElement('span');
  fill.style.width = `${percent}%`;
  track.appendChild(fill);
  const eyebrow = document.createElement('p');
  eyebrow.className = 'recording-detail-eyebrow';
  eyebrow.style.marginBottom = '12px';
  eyebrow.textContent = `${job.files.length} ${job.files.length === 1 ? 'FILE' : 'FILES'}`;
  const files = document.createElement('div');
  files.className = 'recording-detail-upload-files';
  for (const file of job.files) {
    const item = document.createElement('div');
    const complete = file.status === 'uploaded';
    item.className = `recording-detail-upload-file${complete ? ' recording-detail-upload-file--done' : ''}`;
    const head = document.createElement('div');
    head.className = 'recording-detail-upload-file-head';
    const name = document.createElement('span');
    name.className = 'recording-detail-upload-file-name';
    name.textContent = file.filename;
    name.title = file.filename;
    const status = document.createElement('span');
    status.className = 'recording-detail-upload-file-status';
    if (complete) status.innerHTML = DONE_MARK;
    else if (typeof file.bytes === 'number') status.textContent = `${formatBytes(Math.round(file.bytes * job.progress))} / ${formatBytes(file.bytes)}`;
    else status.textContent = file.status === 'retry-pending' ? 'RETRYING' : 'UPLOADING';
    head.append(name, status);
    const fileTrack = document.createElement('div');
    fileTrack.className = 'recording-detail-progress';
    fileTrack.style.height = '5px';
    fileTrack.style.margin = '0';
    const fileFill = document.createElement('span');
    fileFill.style.width = `${complete ? 100 : percent}%`;
    fileTrack.appendChild(fileFill);
    item.append(head, fileTrack);
    files.appendChild(item);
  }
  content.append(title, meta, progress, track, eyebrow, files);
  const footer = document.createElement('footer');
  footer.className = 'recording-detail-footer';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-secondary';
  cancel.textContent = 'Cancel upload';
  cancel.disabled = job.status !== 'uploading';
  cancel.addEventListener('click', () => onCancel(job, cancel));
  footer.appendChild(cancel);
  content.appendChild(footer);
}
