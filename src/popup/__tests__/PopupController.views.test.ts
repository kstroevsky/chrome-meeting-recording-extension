import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPopupController } from '../popupBootstrap';
import type { RecordingStatusView, UploadJob } from '../../shared/recording';

const popupMarkup = readFileSync(resolve(process.cwd(), 'static/popup.html'), 'utf8');
const popupBody = new DOMParser().parseFromString(popupMarkup, 'text/html').body.innerHTML;

const SCREENS = [
  'view-config',
  'view-permission',
  'view-recording',
  'view-finalizing',
  'view-interrupted',
  'view-upload',
  'view-recordings',
  'view-recording-detail',
];
const visibleScreens = () => SCREENS.filter((id) => !document.getElementById(id)?.hidden);
const visible = (id: string) => !document.getElementById(id)?.hidden;

/** A closed meeting tab: the run is sealed, and its upload is still on its way. */
const upload: UploadJob = {
  id: 'job-1',
  historyId: 'recording-1',
  label: 'meet-sst-ttsy-zau-20261006T1411',
  status: 'uploading',
  progress: 0.04,
  startedAt: 0,
  files: [
    { stream: 'mic', filename: 'mic.webm', status: 'uploading', bytes: 100, uploadedBytes: 90 },
    { stream: 'self-video', filename: 'camera.webm', status: 'uploading', bytes: 1_000 },
    { stream: 'tab', filename: 'tab.webm', status: 'uploading', bytes: 2_000, uploadedBytes: 100 },
  ],
};
const stoppedWhileUploading: RecordingStatusView = {
  phase: 'idle',
  runConfig: null,
  updatedAt: 0,
  interruption: { reason: 'tab-closed', atMs: 3_620_000, historyId: 'recording-1' },
  uploadJobs: [upload],
};

describe('PopupController — one screen at a time after the meeting tab closed', () => {
  beforeEach(() => {
    document.body.innerHTML = popupBody;
  });

  it('shows the notice alone, its upload in the header chip rather than under STOPPED', () => {
    createPopupController(document).renderPreview({ screen: 'session', session: stoppedWhileUploading });

    expect(visibleScreens()).toEqual(['view-interrupted']);
    expect(visible('open-upload-navigation')).toBe(true);
    // The label is pinned over the chip's place, so the two never show together.
    expect(visible('header-phase')).toBe(false);
  });

  it('says STOPPED once nothing is uploading', () => {
    createPopupController(document).renderPreview({
      screen: 'session',
      session: { ...stoppedWhileUploading, uploadJobs: [] },
    });

    expect(visibleScreens()).toEqual(['view-interrupted']);
    expect(visible('open-upload-navigation')).toBe(false);
    expect(visible('header-phase')).toBe(true);
    expect(document.getElementById('header-phase')!.textContent).toBe('STOPPED');
  });

  it('opens the upload in place of the notice, not under it', () => {
    createPopupController(document).renderPreview({
      screen: 'session',
      session: stoppedWhileUploading,
      selectedUploadJobId: upload.id,
    });

    expect(visibleScreens()).toEqual(['view-upload']);
  });

  it('opens Recordings in place of the notice, not under it', () => {
    createPopupController(document).renderPreview({
      screen: 'recordings',
      session: stoppedWhileUploading,
      entries: [],
    });

    expect(visibleScreens()).toEqual(['view-recordings']);
  });
});
