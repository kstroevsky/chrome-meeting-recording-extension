import { openStorageTarget } from '../src/offscreen/engine/RecorderTaskUtils';
import { InMemoryStorageTarget } from '../src/offscreen/engine/RecorderEngineTypes';

describe('openStorageTarget (storage fallback ladder)', () => {
  it('buffers in RAM when no storage-target factory is provided', async () => {
    const target = await openStorageTarget('rec.webm', 'video/webm', { warn: jest.fn() });
    expect(target).toBeInstanceOf(InMemoryStorageTarget);
  });

  it('uses the provided target when it opens successfully', async () => {
    const opened = { write: jest.fn(), close: jest.fn() } as any;
    const openTarget = jest.fn().mockResolvedValue(opened);

    const target = await openStorageTarget('rec.webm', 'video/webm', { warn: jest.fn(), openTarget }, 'tab');

    expect(target).toBe(opened);
    expect(openTarget).toHaveBeenCalledWith('rec.webm', 'tab');
  });

  it('falls back to RAM and surfaces a warning for a non-tab stream when opening throws', async () => {
    const warn = jest.fn();
    const reportWarning = jest.fn();
    const openTarget = jest.fn().mockRejectedValue(new Error('OPFS unavailable'));

    const target = await openStorageTarget('mic.webm', 'audio/webm', { warn, reportWarning, openTarget }, 'mic');

    expect(target).toBeInstanceOf(InMemoryStorageTarget);
    expect(warn).toHaveBeenCalled();
    // The downgrade is no longer silent — the user-facing channel is notified too.
    expect(reportWarning).toHaveBeenCalledTimes(1);
    expect(reportWarning.mock.calls[0][0]).toMatch(/buffered in memory/);
  });

  it('fails the recording (throws) instead of RAM-buffering the tab stream when storage cannot open', async () => {
    const warn = jest.fn();
    const reportWarning = jest.fn();
    const openTarget = jest.fn().mockRejectedValue(new Error('OPFS unavailable'));

    await expect(
      openStorageTarget('tab.webm', 'video/webm', { warn, reportWarning, openTarget }, 'tab')
    ).rejects.toThrow(/Couldn't open disk storage/);

    expect(reportWarning).toHaveBeenCalledTimes(1);
    expect(reportWarning.mock.calls[0][0]).toMatch(/was not started/);
  });

  it('fails the tab stream loudly even when no storage-target factory is available', async () => {
    const warn = jest.fn();
    const reportWarning = jest.fn();

    await expect(
      openStorageTarget('tab.webm', 'video/webm', { warn, reportWarning }, 'tab')
    ).rejects.toThrow(/Couldn't open disk storage/);

    expect(reportWarning).toHaveBeenCalledTimes(1);
  });

  it('falls back to RAM (with a surfaced warning) for the optional self-video stream', async () => {
    const warn = jest.fn();
    const reportWarning = jest.fn();
    const openTarget = jest.fn().mockRejectedValue(new Error('OPFS unavailable'));

    // Self-video is supplementary: degrading it still leaves a useful tab(+mic)
    // recording, so we keep the camera rather than block the session.
    const target = await openStorageTarget('cam.webm', 'video/webm', { warn, reportWarning, openTarget }, 'self-video');

    expect(target).toBeInstanceOf(InMemoryStorageTarget);
    expect(reportWarning).toHaveBeenCalledTimes(1);
    expect(reportWarning.mock.calls[0][0]).toMatch(/buffered in memory/);
  });
});
