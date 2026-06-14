import { enforceSelfVideoResolution } from '../src/offscreen/SelfVideoResize';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A test-driven async frame source matching the reader the resize pump consumes. */
class ManualReader {
  private queue: Array<{ value: any; done: boolean }> = [];
  private resolvers: Array<(v: { value: any; done: boolean }) => void> = [];
  cancelled = false;

  push(frame: any) {
    const item = { value: frame, done: false };
    const r = this.resolvers.shift();
    if (r) r(item); else this.queue.push(item);
  }
  end() {
    const item = { value: undefined, done: true };
    const r = this.resolvers.shift();
    if (r) r(item); else this.queue.push(item);
  }
  read() {
    const item = this.queue.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  cancel() { this.cancelled = true; }
}

function makeFrame(extra: Record<string, unknown> = {}) {
  return { timestamp: 1000, duration: 33000, close: jest.fn(), ...extra };
}

describe('enforceSelfVideoResolution', () => {
  describe('no resize needed (insertable streams unavailable)', () => {
    let saved: Record<string, any>;
    beforeEach(() => {
      saved = {
        p: (globalThis as any).MediaStreamTrackProcessor,
        g: (globalThis as any).MediaStreamTrackGenerator,
        c: (globalThis as any).OffscreenCanvas,
        v: (globalThis as any).VideoFrame,
      };
      delete (globalThis as any).MediaStreamTrackProcessor;
      delete (globalThis as any).MediaStreamTrackGenerator;
      delete (globalThis as any).OffscreenCanvas;
      delete (globalThis as any).VideoFrame;
    });
    afterEach(() => {
      (globalThis as any).MediaStreamTrackProcessor = saved.p;
      (globalThis as any).MediaStreamTrackGenerator = saved.g;
      (globalThis as any).OffscreenCanvas = saved.c;
      (globalThis as any).VideoFrame = saved.v;
    });

    it('records the camera track directly and mutes via enabled=false (well-defined)', async () => {
      const track = { enabled: true };
      const source = { getVideoTracks: () => [track], getTracks: () => [track] } as any;

      const enforced = await enforceSelfVideoResolution(source, { width: 640, height: 360 }, () => {});

      expect(enforced.resized).toBe(false);
      expect(enforced.stream).toBe(source);

      enforced.setMuted(true);
      expect(track.enabled).toBe(false);
      enforced.setMuted(false);
      expect(track.enabled).toBe(true);
    });
  });

  describe('resized path blacks out inside the pump, not via enabled', () => {
    let ctx: { fillStyle: string; drawImage: jest.Mock; fillRect: jest.Mock };
    let generators: any[];
    let savedReader: ManualReader;

    beforeEach(() => {
      ctx = { fillStyle: '', drawImage: jest.fn(), fillRect: jest.fn() };
      generators = [];

      class MockProcessor {
        readable: { getReader: () => any };
        constructor({ track }: { track: any }) {
          if (track.__manual) {
            this.readable = { getReader: () => track.__manual };
          } else {
            // Probe clone used by detectCodedSize: one frame at the coded size.
            const frames = [{ codedWidth: 1280, codedHeight: 720, close: jest.fn() }];
            let i = 0;
            const reader = {
              read: async () => (i < frames.length ? { value: frames[i++], done: false } : { value: undefined, done: true }),
              cancel: async () => {},
            };
            this.readable = { getReader: () => reader };
          }
        }
      }
      class MockGenerator {
        kind: string;
        contentHint = '';
        written: any[] = [];
        writable: { getWriter: () => any };
        constructor({ kind }: { kind: string }) {
          this.kind = kind;
          const written = this.written;
          this.writable = { getWriter: () => ({ write: async (f: any) => { written.push(f); }, close: async () => {} }) };
          generators.push(this);
        }
        stop() {}
      }
      class MockOffscreenCanvas {
        constructor(public width: number, public height: number) {}
        getContext() { return ctx; }
      }
      class MockVideoFrame {
        timestamp: number;
        constructor(_canvas: any, opts: { timestamp: number }) { this.timestamp = opts.timestamp; }
        close() {}
      }

      class MockMediaStream {
        constructor(public __tracks: any[] = []) {}
        getVideoTracks() { return this.__tracks; }
        getTracks() { return this.__tracks; }
      }

      (globalThis as any).MediaStreamTrackProcessor = MockProcessor;
      (globalThis as any).MediaStreamTrackGenerator = MockGenerator;
      (globalThis as any).OffscreenCanvas = MockOffscreenCanvas;
      (globalThis as any).VideoFrame = MockVideoFrame;
      (globalThis as any).MediaStream = MockMediaStream;
    });

    afterEach(() => {
      delete (globalThis as any).MediaStreamTrackProcessor;
      delete (globalThis as any).MediaStreamTrackGenerator;
      delete (globalThis as any).OffscreenCanvas;
      delete (globalThis as any).VideoFrame;
      delete (globalThis as any).MediaStream;
    });

    it('writes black frames while muted (no real frame drawn) and keeps the cadence', async () => {
      savedReader = new ManualReader();
      const sourceTrack: any = {
        enabled: true,
        stop: jest.fn(),
        getSettings: () => ({ width: 1280, height: 720 }),
        clone: () => ({ __probe: true, stop: jest.fn() }),
        __manual: savedReader,
      };
      const source = { getVideoTracks: () => [sourceTrack], getTracks: () => [sourceTrack] } as any;

      const enforced = await enforceSelfVideoResolution(source, { width: 640, height: 360 }, () => {});
      expect(enforced.resized).toBe(true);
      const generator = generators[0];

      // Live: the real camera frame is drawn and encoded.
      savedReader.push(makeFrame({ timestamp: 1000 }));
      await flush();
      expect(ctx.drawImage).toHaveBeenCalledTimes(1);
      expect(ctx.fillRect).not.toHaveBeenCalled();
      expect(generator.written).toHaveLength(1);

      // Hidden: the next frame is filled black; the real frame is NOT drawn, but a
      // frame is still written so the timeline stays continuous.
      enforced.setMuted(true);
      savedReader.push(makeFrame({ timestamp: 2000 }));
      await flush();
      expect(ctx.fillRect).toHaveBeenCalledTimes(1);
      expect(ctx.drawImage).toHaveBeenCalledTimes(1);
      expect(generator.written).toHaveLength(2);

      // Shown again: back to drawing the real frame.
      enforced.setMuted(false);
      savedReader.push(makeFrame({ timestamp: 3000 }));
      await flush();
      expect(ctx.drawImage).toHaveBeenCalledTimes(2);
      expect(generator.written).toHaveLength(3);

      savedReader.end();
      await flush();
    });
  });
});
