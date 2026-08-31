import { SessionTabsView, type SessionTabsCallbacks } from '../SessionTabsView';
import { sendToBackground } from '../../shared/messages';
import type { PopupElements } from '../popupView';
import type { RecordingStatusView, UploadJob } from '../../shared/recording';

jest.mock('../../shared/messages', () => ({ sendToBackground: jest.fn() }));
const mockSend = sendToBackground as jest.MockedFunction<typeof sendToBackground>;

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const makeEl = (): PopupElements => ({
  sessionTabs: document.createElement('div'),
  uploadProgress: document.createElement('div'),
  uploadDone: document.createElement('div'),
  uploadJobLabel: document.createElement('div'),
  uploadJobPct: document.createElement('span'),
  uploadBarFill: document.createElement('div'),
  uploadJobMeta: document.createElement('div'),
  uploadJobSub: document.createElement('div'),
  uploadJobFiles: document.createElement('ul'),
  uploadJobNotesLine: document.createElement('div'),
  uploadJobNotesState: document.createElement('span'),
  uploadJobOpenDrive: document.createElement('button'),
  uploadJobRetry: document.createElement('button'),
  uploadJobCancel: document.createElement('button'),
} as unknown as PopupElements);

const job = (over: Partial<UploadJob> = {}): UploadJob => ({
  id: 'j1',
  label: 'meet-abc',
  status: 'uploading',
  progress: 0.42,
  startedAt: 1,
  files: [{ stream: 'tab', filename: 'tab.webm', status: 'uploading' }],
  ...over,
} as UploadJob);

const sessionWith = (jobs: UploadJob[]): RecordingStatusView =>
  ({ phase: 'idle', uploadJobs: jobs } as unknown as RecordingStatusView);

describe('SessionTabsView', () => {
  let el: PopupElements;
  let callbacks: { rerender: jest.Mock; applySession: jest.Mock; toast: jest.Mock };
  let view: SessionTabsView;

  beforeEach(() => {
    jest.clearAllMocks();
    (chrome.tabs.create as jest.Mock).mockClear();
    el = makeEl();
    callbacks = { rerender: jest.fn(), applySession: jest.fn(), toast: jest.fn() };
    view = new SessionTabsView(el, callbacks as unknown as SessionTabsCallbacks);
  });

  it('hides the tab bar when there are no upload jobs', () => {
    view.sync('idle', sessionWith([]));
    expect(el.sessionTabs!.hidden).toBe(true);
    expect(el.sessionTabs!.querySelectorAll('.session-tab')).toHaveLength(0);
  });

  it('renders upload tabs plus the live anchor, and activeJob tracks the selection', () => {
    view.sync('idle', sessionWith([job()]));
    const tabs = el.sessionTabs!.querySelectorAll('.session-tab');
    expect(tabs).toHaveLength(2); // the job + the live/＋New anchor
    expect(view.activeJob(sessionWith([job()]))).toBeNull(); // 'live' selected by default
  });

  it('clicking an upload tab selects it and asks the controller to re-render', () => {
    view.sync('idle', sessionWith([job()]));
    (el.sessionTabs!.querySelector('.session-tab[data-tab="j1"]') as HTMLButtonElement).click();
    expect(callbacks.rerender).toHaveBeenCalledTimes(1);
    expect(view.activeJob(sessionWith([job()]))?.id).toBe('j1'); // now tracking j1
  });

  it('retry applies the session returned by the background', async () => {
    mockSend.mockResolvedValue({ ok: true, session: { phase: 'idle' } } as never);
    view.wireEvents();
    view.renderJobView(job({ status: 'failed', progress: 0 }));
    el.uploadJobRetry!.click();
    await flush();

    expect(mockSend).toHaveBeenCalledWith({ type: 'RETRY_UPLOAD_JOB', jobId: 'j1' });
    expect(callbacks.applySession).toHaveBeenCalledWith({ phase: 'idle' });
  });

  it('retry surfaces a toast when the background rejects it', async () => {
    mockSend.mockResolvedValue({ ok: false, error: 'gone', session: { phase: 'idle' } } as never);
    view.wireEvents();
    view.renderJobView(job({ status: 'failed', progress: 0 }));
    el.uploadJobRetry!.click();
    await flush();

    expect(callbacks.toast).toHaveBeenCalledWith('gone');
  });

  it('cancels an in-progress upload and reports the local-download fallback', async () => {
    mockSend.mockResolvedValue({ ok: true, session: { phase: 'idle' } } as never);
    view.wireEvents();
    view.renderJobView(job());

    expect(el.uploadJobCancel!.hidden).toBe(false);
    el.uploadJobCancel!.click();
    await flush();

    expect(mockSend).toHaveBeenCalledWith({ type: 'CANCEL_UPLOAD_JOB', jobId: 'j1' });
    expect(callbacks.toast).toHaveBeenCalledWith('Canceling upload — downloading locally…');
    expect(callbacks.applySession).not.toHaveBeenCalled();
    expect(el.uploadJobCancel!.disabled).toBe(true);

    view.renderJobView(job({ status: 'canceled', progress: 1, files: [{ stream: 'tab', filename: 'tab.webm', status: 'fallback' }] }));
    expect(el.uploadJobCancel!.hidden).toBe(true);
    expect(el.uploadJobLabel!.textContent).toBe('Upload canceled — saved locally');
  });

  it('renders a retained recovery as retry-pending without offering an unavailable in-memory retry', () => {
    view.renderJobView(job({
      status: 'failed',
      recoveryPending: true,
      progress: 1,
      files: [{ stream: 'tab', filename: 'tab.webm', status: 'retry-pending', error: 'network down' }],
    }));

    expect(el.uploadJobLabel!.textContent).toContain('retrying when the recorder starts');
    expect(el.uploadJobFiles!.textContent).toContain('Retry pending');
    expect(el.uploadJobRetry!.hidden).toBe(true);
  });

  it('does not claim a missing recovery source was saved locally', () => {
    view.renderJobView(job({
      status: 'failed',
      progress: 1,
      files: [{ stream: 'tab', filename: 'tab.webm', status: 'unavailable', error: 'OPFS file missing' }],
    }));

    expect(el.uploadJobLabel!.textContent).toBe('Upload failed — recovery source is unavailable');
    expect(el.uploadJobFiles!.textContent).toContain('OPFS file missing');
    expect(el.uploadJobRetry!.hidden).toBe(true);
  });

  it('renders a completed job as the saved recording view with real filenames', () => {
    view.wireEvents();
    view.renderJobView(job({
      status: 'completed',
      progress: 1,
      folderWebViewLink: 'https://drive.google.com/drive/folders/folder-1',
      files: [
        { stream: 'tab', filename: 'meet-tab.webm', status: 'uploaded', bytes: 92 * 1024 * 1024, webViewLink: 'https://drive.google.com/file/d/tab/view' },
        { stream: 'mic', filename: 'meet-mic.webm', status: 'uploaded', bytes: 12 * 1024 * 1024, webViewLink: 'https://drive.google.com/file/d/mic/view' },
        { stream: 'self-video', filename: 'meet-camera.webm', status: 'uploaded', bytes: 34 * 1024 * 1024, webViewLink: 'https://drive.google.com/file/d/camera/view' },
      ],
    }));

    expect(el.uploadProgress!.hidden).toBe(true);
    expect(el.uploadDone!.hidden).toBe(false);
    expect(el.uploadJobLabel!.textContent).toBe('Recording saved');
    expect(el.uploadJobSub!.textContent).toBe('3 files · 138 MB · Google Drive');
    expect(el.uploadJobFiles!.querySelectorAll('li')).toHaveLength(3);
    expect(el.uploadJobFiles!.textContent).toContain('meet-tab.webm');
    expect(el.uploadJobFiles!.textContent).toContain('meet-mic.webm');
    expect(el.uploadJobFiles!.textContent).toContain('meet-camera.webm');
    expect(el.uploadJobFiles!.textContent).toContain('92 MB');
    expect(el.uploadJobFiles!.querySelectorAll('.file-open')).toHaveLength(3);
    expect(el.uploadJobFiles!.querySelectorAll('.file-head .file-open')).toHaveLength(3);
    expect(el.uploadJobOpenDrive!.hidden).toBe(false);
    expect(el.uploadJobRetry!.hidden).toBe(true);

    (el.uploadJobFiles!.querySelector('.file-open') as HTMLButtonElement).click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://drive.google.com/file/d/tab/view' });
    el.uploadJobOpenDrive!.click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://drive.google.com/drive/folders/folder-1' });
  });

  it('renders an in-progress job as a linear bar with a real aggregate + background button', () => {
    view.wireEvents();
    view.renderJobView(job({
      status: 'uploading',
      progress: 0.42,
      files: [
        { stream: 'tab', filename: 'tab.webm', status: 'uploaded', bytes: 90 * 1024 * 1024 },
        { stream: 'mic', filename: 'mic.webm', status: 'uploading' },
      ],
    }));

    expect(el.uploadProgress!.hidden).toBe(false);
    expect(el.uploadDone!.hidden).toBe(true);
    expect(el.uploadJobPct!.textContent).toBe('42%');
    expect(el.uploadBarFill!.style.width).toBe('42%');
    expect(el.uploadJobMeta!.textContent).toBe('2 files');
    expect(el.uploadJobOpenDrive!.hidden).toBe(true);
  });

  it('dismissing a finished tab via its × sends DISMISS and applies the new session', async () => {
    mockSend.mockResolvedValue({ ok: true, session: { phase: 'idle' } } as never);
    view.sync('idle', sessionWith([job({ status: 'completed', progress: 1 })]));
    (el.sessionTabs!.querySelector('.session-tab-close') as HTMLElement).click();
    await flush();

    expect(mockSend).toHaveBeenCalledWith({ type: 'DISMISS_UPLOAD_JOB', jobId: 'j1' });
    expect(callbacks.applySession).toHaveBeenCalledWith({ phase: 'idle' });
  });

  it('does not auto-dismiss a completed upload while its naming prompt is pending', () => {
    jest.useFakeTimers();
    view.sync('idle', sessionWith([job({ status: 'completed', progress: 1, namingStatus: 'pending' })]));

    jest.advanceTimersByTime(20_000);

    expect(mockSend).not.toHaveBeenCalledWith({ type: 'DISMISS_UPLOAD_JOB', jobId: 'j1' });
    jest.useRealTimers();
  });

  describe('notes sidecar line (d4)', () => {
    const withNotes = (status: 'uploading' | 'uploaded') => job({
      files: [
        { stream: 'tab', kind: 'notes', filename: 'meet-notes.vtt', status, bytes: 400 },
        { stream: 'tab', filename: 'tab.webm', status: 'uploading', bytes: 1_000_000 },
      ],
    });

    it('claims SAVED FIRST only once the sidecar is actually up', () => {
      view.renderJobView(withNotes('uploading'));
      expect(el.uploadJobNotesLine!.hidden).toBe(false);
      expect(el.uploadJobNotesState!.textContent).toBe('SAVING FIRST');
      expect(el.uploadJobNotesLine!.classList.contains('upload-notes--saved')).toBe(false);

      view.renderJobView(withNotes('uploaded'));
      expect(el.uploadJobNotesState!.textContent).toBe('SAVED FIRST');
      expect(el.uploadJobNotesLine!.classList.contains('upload-notes--saved')).toBe(true);
    });

    it('keeps the sidecar out of the media file list, count and size', () => {
      view.renderJobView(withNotes('uploaded'));

      // One media file, and the sidecar's bytes do not inflate the size.
      expect(el.uploadJobFiles!.children).toHaveLength(1);
      expect(el.uploadJobFiles!.textContent).toContain('tab.webm');
      expect(el.uploadJobFiles!.textContent).not.toContain('meet-notes.vtt');
      expect(el.uploadJobMeta!.textContent).toContain('1 file');
      expect(el.uploadJobSub!.textContent).not.toContain('1.0 MB · 400');
    });

    it('stays hidden for a recording with no notes', () => {
      view.renderJobView(job());
      expect(el.uploadJobNotesLine!.hidden).toBe(true);
    });
  });
});
