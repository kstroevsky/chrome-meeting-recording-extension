import { InMemoryStorageTarget } from '../src/offscreen/engine/RecorderEngineTypes';

const chunk = (size: number) => new Blob([new Uint8Array(size)]);

describe('InMemoryStorageTarget (RAM last-resort fallback)', () => {
  it('assembles buffered chunks into a single File on close', async () => {
    const target = new InMemoryStorageTarget('rec.webm', 'video/webm');
    await target.write(chunk(100));
    await target.write(chunk(50));

    const sealed = await target.close();
    expect(sealed).not.toBeNull();
    expect(sealed!.filename).toBe('rec.webm');
    expect(sealed!.file.size).toBe(150);
    expect(sealed!.file.type).toBe('video/webm');
    await expect(sealed!.cleanup()).resolves.toBeUndefined();
  });

  it('returns null when closed with no chunks', async () => {
    const target = new InMemoryStorageTarget('rec.webm', 'video/webm');
    expect(await target.close()).toBeNull();
  });

  it('returns null and is a no-op on a second close', async () => {
    const target = new InMemoryStorageTarget('rec.webm', 'video/webm');
    await target.write(chunk(10));
    expect(await target.close()).not.toBeNull();
    expect(await target.close()).toBeNull();
  });

  it('rejects writes after close', async () => {
    const target = new InMemoryStorageTarget('rec.webm', 'video/webm');
    await target.close();
    await expect(target.write(chunk(10))).rejects.toThrow(/closed/);
  });
});
