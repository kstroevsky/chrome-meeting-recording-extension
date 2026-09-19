/**
 * @file popup/history/uploadDetailPanel.ts
 *
 * The detail screen for an upload still in flight: where it stands, then each
 * file on its own — saved, uploading with its share, or queued — the same rows
 * the saving screen draws (d4).
 */

import { detailPercent, recordingDetailWhen } from './historyChrome';
import { uploadingRow } from './uploadJobPanel';
import type { UploadJob } from '../../shared/recording';

export function renderUploadDetail(
content: HTMLElement,
job: UploadJob,
onCancel: (job: UploadJob, button: HTMLButtonElement) => void,
): void {
  // The header already names the upload; the body is d4's progress list.
  const media = job.files.filter((file) => file.kind !== 'notes');
  const landed = media.filter((file) => file.status === 'uploaded').length;
  const meta = document.createElement('p');
  meta.className = 'recording-detail-meta';
  meta.textContent = `${landed} OF ${media.length} ${media.length === 1 ? 'FILE' : 'FILES'} · ${job.status === 'uploading' ? `${detailPercent(job.progress)}%` : job.status.toUpperCase()} · ${recordingDetailWhen(job.startedAt)}`;
  const eyebrow = document.createElement('p');
  eyebrow.className = 'recording-detail-eyebrow';
  eyebrow.textContent = 'PROGRESS';
  const files = document.createElement('ul');
  files.className = 'up-files recording-detail-upload-files';
  for (const file of media) files.appendChild(uploadingRow(file));
  content.append(meta, eyebrow, files);
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
