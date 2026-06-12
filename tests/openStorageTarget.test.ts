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

  it('falls back to RAM (with a warning) when opening the target throws', async () => {
    const warn = jest.fn();
    const openTarget = jest.fn().mockRejectedValue(new Error('OPFS unavailable'));

    const target = await openStorageTarget('rec.webm', 'video/webm', { warn, openTarget }, 'tab');

    expect(target).toBeInstanceOf(InMemoryStorageTarget);
    expect(warn).toHaveBeenCalled();
  });
});
