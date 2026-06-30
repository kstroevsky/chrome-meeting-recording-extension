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
  uploadJobRing: document.createElement('div'),
  uploadJobRingArc: document.createElement('div'),
  uploadJobRingLabel: document.createElement('span'),
  uploadJobLabel: document.createElement('div'),
  uploadJobFiles: document.createElement('ul'),
  uploadJobRetry: document.createElement('button'),
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

  it('dismissing a finished tab via its × sends DISMISS and applies the new session', async () => {
    mockSend.mockResolvedValue({ ok: true, session: { phase: 'idle' } } as never);
    view.sync('idle', sessionWith([job({ status: 'completed', progress: 1 })]));
    (el.sessionTabs!.querySelector('.session-tab-close') as HTMLElement).click();
    await flush();

    expect(mockSend).toHaveBeenCalledWith({ type: 'DISMISS_UPLOAD_JOB', jobId: 'j1' });
    expect(callbacks.applySession).toHaveBeenCalledWith({ phase: 'idle' });
  });
});
