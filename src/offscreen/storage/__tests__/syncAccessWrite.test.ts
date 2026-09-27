import { writeSyncFully } from '../syncAccessWrite';

describe('writeSyncFully', () => {
  it('retries the unwritten suffix at the exact next offset', () => {
    const calls: Array<{ bytes: number[]; at: number | undefined }> = [];
    const progress = [2, 3, 3];
    const writer = {
      write(buffer: BufferSource, options?: { at?: number }) {
        const bytes = Array.from(new Uint8Array(
          ArrayBuffer.isView(buffer) ? buffer.buffer : buffer,
          ArrayBuffer.isView(buffer) ? buffer.byteOffset : 0,
          ArrayBuffer.isView(buffer) ? buffer.byteLength : buffer.byteLength,
        ));
        calls.push({ bytes, at: options?.at });
        return progress.shift() ?? bytes.length;
      },
    };

    expect(writeSyncFully(writer, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), 10)).toBe(8);
    expect(calls).toEqual([
      { bytes: [1, 2, 3, 4, 5, 6, 7, 8], at: 10 },
      { bytes: [3, 4, 5, 6, 7, 8], at: 12 },
      { bytes: [6, 7, 8], at: 15 },
    ]);
  });

  it.each([0, -1, Number.NaN, 9])('rejects invalid write progress %p', (count) => {
    const writer = { write: () => count };
    expect(() => writeSyncFully(writer, new Uint8Array(8), 0)).toThrow(/invalid progress/);
  });
});
