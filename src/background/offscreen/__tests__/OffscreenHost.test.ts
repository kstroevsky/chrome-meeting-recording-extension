import { OffscreenHost } from '../OffscreenHost';

function connection() {
  return {
    currentPort: null,
    isReady: false,
    markNotReady: jest.fn(),
    resetReadyPromise: jest.fn(),
    getOrCreateReadyPromise: jest.fn(() => Promise.resolve()),
    clearPort: jest.fn(),
    failReady: jest.fn(),
    markReady: jest.fn(),
  };
}

describe('OffscreenHost', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (chrome.offscreen.hasDocument as jest.Mock).mockResolvedValue(false);
    (chrome.offscreen.closeDocument as jest.Mock).mockResolvedValue(undefined);
  });

  it('switches capture to a ready extension tab through the platform seam', async () => {
    const state = connection();
    (chrome.tabs.create as jest.Mock).mockResolvedValue({ id: 99 });
    const host = new OffscreenHost(
      state as never,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );

    await expect(host.ensureRecorderTabReady()).resolves.toBe(99);

    expect(state.markNotReady).toHaveBeenCalledTimes(1);
    expect(state.clearPort).toHaveBeenCalledWith(true);
    expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://mock-id/offscreen.html?runtime=tab',
      active: true,
    });
    expect(host.hasRecorderTab()).toBe(true);
    expect(host.isTransitioning()).toBe(false);
  });

  it('leaves the current host intact when an update arrives during critical work', async () => {
    const state = connection();
    const host = new OffscreenHost(
      state as never,
      { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    );

    await expect(host.closeForUpdate(true)).resolves.toBe(false);
    expect(state.markNotReady).not.toHaveBeenCalled();
    expect(chrome.offscreen.closeDocument).not.toHaveBeenCalled();
  });
});
