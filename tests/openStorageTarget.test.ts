import { openStorageTarget } from '../src/offscreen/engine/RecorderTaskUtils';
import { InMemoryStorageTarget } from '../src/offscreen/engine/RecorderEngineTypes';

/** A fake oversized chunk: write() only reads `.size`, so no real allocation. */
const sizedChunk = (bytes: number) => ({ size: bytes }) as unknown as Blob;

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

  it('caps the optional-stream RAM buffer and stops just that stream on overflow', async () => {
    const warn = jest.fn();
    const reportWarning = jest.fn();
    const requestStopStream = jest.fn();
    const openTarget = jest.fn().mockRejectedValue(new Error('OPFS unavailable'));

    const target = await openStorageTarget(
      'cam.webm', 'video/webm', { warn, reportWarning, openTarget, requestStopStream }, 'self-video'
    );
    expect(target).toBeInstanceOf(InMemoryStorageTarget);

    // Under the 512 MB default cap: no escalation.
    await target.write(sizedChunk(10 * 1024 * 1024));
    expect(requestStopStream).not.toHaveBeenCalled();

    // Crossing the cap stops just this stream (not the whole session).
    await target.write(sizedChunk(600 * 1024 * 1024));
    expect(requestStopStream).toHaveBeenCalledWith('self-video');
    expect(reportWarning).toHaveBeenCalledWith(expect.stringMatching(/stopping just this stream/));

    // Idempotent: a further oversized write does not re-escalate.
    await target.write(sizedChunk(600 * 1024 * 1024));
    expect(requestStopStream).toHaveBeenCalledTimes(1);
  });
});

describe('InMemoryStorageTarget RAM cap', () => {
  it('fires onOverflow exactly once when buffered bytes cross the cap', async () => {
    const onOverflow = jest.fn();
    const target = new InMemoryStorageTarget('x.webm', 'video/webm', { maxBufferedBytes: 1000, onOverflow });

    await target.write(sizedChunk(600));
    expect(onOverflow).not.toHaveBeenCalled(); // 600 <= 1000
    await target.write(sizedChunk(600));        // 1200 > 1000
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onOverflow).toHaveBeenCalledWith(1200);
    await target.write(sizedChunk(600));        // still over, fires only once
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it('never fires onOverflow while under the cap', async () => {
    const onOverflow = jest.fn();
    const target = new InMemoryStorageTarget('x.webm', 'video/webm', { maxBufferedBytes: 10_000, onOverflow });
    await target.write(sizedChunk(1000));
    await target.write(sizedChunk(1000));
    expect(onOverflow).not.toHaveBeenCalled();
  });
});
