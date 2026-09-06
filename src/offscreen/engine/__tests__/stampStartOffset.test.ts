import { stampStartOffset } from '../RecorderTaskUtils';
import type { SealedStorageFile } from '../RecorderEngineTypes';

const artifact = (): SealedStorageFile => ({
  filename: 'tab.webm', file: new Blob(['x']), cleanup: async () => {},
});

describe('stampStartOffset', () => {
  it('records how long after the run this recorder actually started', () => {
    const sealed = artifact();
    stampStartOffset(sealed, 10_240, 10_000);
    expect(sealed.startOffsetMs).toBe(240);
  });

  it('keeps a negative offset, which means this stream started first', () => {
    const sealed = artifact();
    stampStartOffset(sealed, 9_880, 10_000);
    expect(sealed.startOffsetMs).toBe(-120);
  });

  it('rounds, because a sub-millisecond offset is noise the clock cannot use', () => {
    const sealed = artifact();
    stampStartOffset(sealed, 10_000.6, 10_000);
    expect(sealed.startOffsetMs).toBe(1);
  });

  it('leaves the offset absent when the recorder never reported a start', () => {
    const sealed = artifact();
    stampStartOffset(sealed, 0, 10_000);
    // Absent, not zero: an unmeasured offset must not read as "measured, aligned".
    expect(sealed.startOffsetMs).toBeUndefined();
  });

  it('tolerates a run that produced no artifact', () => {
    expect(() => stampStartOffset(null, 10_240, 10_000)).not.toThrow();
  });
});
