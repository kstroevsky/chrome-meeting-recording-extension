import { CaptionPoller } from '../CaptionPoller';
import { queryActiveTab } from '../../platform/chrome/tabs';
import { sendToContent } from '../../shared/messages';

jest.mock('../../platform/chrome/tabs', () => ({ queryActiveTab: jest.fn() }));
jest.mock('../../shared/messages', () => ({ sendToContent: jest.fn() }));

const mockQueryActiveTab = queryActiveTab as jest.MockedFunction<typeof queryActiveTab>;
const mockSendToContent = sendToContent as jest.MockedFunction<typeof sendToContent>;

/** Drains the poll's await chain (queryActiveTab → sendToContent → DOM writes). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('CaptionPoller', () => {
  let label: HTMLElement;
  let chip: HTMLElement;

  beforeEach(() => {
    jest.clearAllMocks();
    label = document.createElement('span');
    chip = document.createElement('span');
    chip.classList.add('off'); // start "off" so we can prove it gets cleared
  });

  it('reports captions on when the active tab confirms them', async () => {
    mockQueryActiveTab.mockResolvedValue({ id: 7 } as chrome.tabs.Tab);
    mockSendToContent.mockResolvedValue({ captionsActive: true } as never);

    const poller = new CaptionPoller(label, chip);
    poller.start();
    await flush();
    poller.stop();

    expect(mockSendToContent).toHaveBeenCalledWith(7, { type: 'GET_CAPTION_STATE' });
    expect(label.textContent).toBe('Transcript on');
    expect(chip.classList.contains('off')).toBe(false);
  });

  it('reports off when the content script is unreachable', async () => {
    mockQueryActiveTab.mockResolvedValue({ id: 7 } as chrome.tabs.Tab);
    mockSendToContent.mockRejectedValue(new Error('Receiving end does not exist'));

    const poller = new CaptionPoller(label, chip);
    poller.start();
    await flush();
    poller.stop();

    expect(label.textContent).toBe('Transcript off');
    expect(chip.classList.contains('off')).toBe(true);
  });

  it('reports off when there is no active tab (never queries content)', async () => {
    mockQueryActiveTab.mockResolvedValue(undefined);

    const poller = new CaptionPoller(label, chip);
    poller.start();
    await flush();
    poller.stop();

    expect(mockSendToContent).not.toHaveBeenCalled();
    expect(label.textContent).toBe('Transcript off');
    expect(chip.classList.contains('off')).toBe(true);
  });

  it('start() is idempotent — a second call does not double-schedule', async () => {
    jest.useFakeTimers();
    mockQueryActiveTab.mockResolvedValue({ id: 7 } as chrome.tabs.Tab);
    mockSendToContent.mockResolvedValue({ captionsActive: false } as never);

    const poller = new CaptionPoller(label, chip);
    poller.start();
    poller.start(); // must not add a second immediate poll or a second interval
    await Promise.resolve();
    expect(mockQueryActiveTab).toHaveBeenCalledTimes(1);

    poller.stop();
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(mockQueryActiveTab).toHaveBeenCalledTimes(1); // stopped — no further polls
    jest.useRealTimers();
  });
});
