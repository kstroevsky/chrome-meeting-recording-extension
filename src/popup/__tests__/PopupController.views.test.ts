import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPopupController } from '../popupBootstrap';
import type { PopupPreviewState } from '../popupPreviewState';
import type { RecordingStatusView, UploadJob } from '../../shared/recording';

const popupMarkup = readFileSync(resolve(process.cwd(), 'static/popup.html'), 'utf8');
const popupBody = new DOMParser().parseFromString(popupMarkup, 'text/html').body.innerHTML;

const SCREENS = [
  'view-config',
  'view-permission',
  'view-recording',
  'view-finalizing',
  'view-upload',
  'view-recordings',
  'view-recording-detail',
];
const visibleScreens = () => SCREENS.filter((id) => !document.getElementById(id)?.hidden);
const visible = (id: string) => !document.getElementById(id)?.hidden;

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
/** Stopped with the Stop button: the run is sealed and its upload is on its way. */
const stopped: RecordingStatusView = { phase: 'idle', runConfig: null, updatedAt: 0, uploadJobs: [upload] };
/** The same run, finished by closing the meeting tab instead. */
const tabClosed: RecordingStatusView = {
  ...stopped,
  interruption: { reason: 'tab-closed', atMs: 3_620_000, historyId: 'recording-1' },
};

/** What the popup shows: which screen, and what its header says. */
function render(preview: PopupPreviewState) {
  document.body.innerHTML = popupBody;
  createPopupController(document).renderPreview(preview);
  return {
    screens: visibleScreens(),
    phaseLabel: visible('header-phase') ? document.getElementById('header-phase')!.textContent : null,
    uploadChip: visible('open-upload-navigation'),
  };
}

describe('PopupController — closing the meeting tab finishes the recording', () => {
  it('like Stop: the same screen, its upload in the header chip, and nothing asked', () => {
    const afterTabClosed = render({ screen: 'session', session: tabClosed });

    expect(afterTabClosed).toEqual(render({ screen: 'session', session: stopped }));
    expect(afterTabClosed).toEqual({ screens: ['view-config'], phaseLabel: null, uploadChip: true });
  });

  it('like Stop when there is nothing left to upload', () => {
    const quiet = { ...tabClosed, uploadJobs: [] };

    expect(render({ screen: 'session', session: quiet }))
      .toEqual(render({ screen: 'session', session: { ...stopped, uploadJobs: [] } }));
    expect(visibleScreens()).toEqual(['view-config']);
  });

  it('opens its upload alone', () => {
    expect(render({ screen: 'session', session: tabClosed, selectedUploadJobId: upload.id }).screens)
      .toEqual(['view-upload']);
  });

  it('opens Recordings alone', () => {
    expect(render({ screen: 'recordings', session: tabClosed, entries: [] }).screens)
      .toEqual(['view-recordings']);
  });
});
