import { postprocessVideoArtifact } from '../src/offscreen/TabArtifactPostprocessor';
import * as RecorderVideoResizer from '../src/offscreen/RecorderVideoResizer';

async function toText(payload: unknown): Promise<string> {
  const asAny = payload as any;
  if (typeof asAny?.text === 'function') return asAny.text();
  if (typeof asAny?.arrayBuffer === 'function') {
    const ab = await asAny.arrayBuffer();
    return new TextDecoder().decode(ab);
  }
  if (typeof FileReader !== 'undefined' && typeof asAny?.size === 'number' && typeof asAny?.slice === 'function') {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.readAsText(asAny as Blob);
    });
  }
  return String(payload ?? '');
}

function makeTrack(kind: 'audio' | 'video', settings?: Record<string, unknown>) {
  return {
    kind,
    stop: jest.fn(),
    getSettings: () => settings ?? {},
  };
}

function makeStream(tracks: any[]): MediaStream {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((track) => track.kind === 'audio'),
    getVideoTracks: () => tracks.filter((track) => track.kind === 'video'),
  } as any;
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = jest.fn((mime: string) =>
    mime.startsWith('video/webm') || mime.startsWith('video/mp4')
  );

  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  state = 'inactive';

  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  start = jest.fn(() => {
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  });

  stop = jest.fn(() => {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({
        data: new Blob(['processed'], { type: this.options.mimeType || 'video/webm' }),
      } as BlobEvent);
      this.onstop?.();
    });
  });
}

describe('TabArtifactPostprocessor', () => {
  let originalMediaRecorder: typeof MediaRecorder;
  let originalCreateElement: typeof document.createElement;
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;

  beforeEach(() => {
    originalMediaRecorder = global.MediaRecorder as any;
    originalCreateElement = document.createElement.bind(document);
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;

    (global as any).MediaRecorder = FakeMediaRecorder as any;
    FakeMediaRecorder.instances = [];
    URL.createObjectURL = jest.fn(() => 'blob:input');
    URL.revokeObjectURL = jest.fn();
  });

  afterEach(() => {
    (global as any).MediaRecorder = originalMediaRecorder;
    document.createElement = originalCreateElement;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    jest.restoreAllMocks();
  });

  it('replays the sealed artifact through the recorder and returns the resized output artifact', async () => {
    const playbackStream = makeStream([
      makeTrack('audio'),
      makeTrack('video', { width: 1920, height: 1080, frameRate: 30 }),
    ]);
    const resizedStream = makeStream([
      makeTrack('audio'),
      makeTrack('video', { width: 640, height: 360, frameRate: 24 }),
    ]);
    const cleanupResized = jest.fn();
    jest.spyOn(RecorderVideoResizer, 'createResizedVideoStream').mockResolvedValue({
      stream: resizedStream,
      resized: true,
      source: { width: 1920, height: 1080, frameRate: 30 },
      output: { width: 640, height: 360, frameRate: 24 },
      cleanup: cleanupResized,
    });
    jest.spyOn(RecorderVideoResizer, 'readStreamVideoMetrics').mockReturnValue({
      width: 640,
      height: 360,
      frameRate: 24,
    });

    const listeners = new Map<string, Set<() => void>>();
    const emit = (eventName: string) => {
      for (const listener of listeners.get(eventName) ?? []) listener();
    };
    let playCount = 0;
    const video = {
      src: '',
      muted: false,
      playsInline: false,
      autoplay: false,
      hidden: false,
      preload: '',
      style: {},
      currentTime: 0,
      videoWidth: 1920,
      videoHeight: 1080,
      play: jest.fn().mockImplementation(async () => {
        playCount += 1;
        if (playCount >= 2) {
          queueMicrotask(() => emit('ended'));
        }
      }),
      pause: jest.fn(),
      load: jest.fn(),
      addEventListener: jest.fn((eventName: string, handler: () => void) => {
        const set = listeners.get(eventName) ?? new Set<() => void>();
        set.add(handler);
        listeners.set(eventName, set);
      }),
      removeEventListener: jest.fn((eventName: string, handler: () => void) => {
        listeners.get(eventName)?.delete(handler);
      }),
      captureStream: jest.fn(() => playbackStream),
    } as any;

    document.createElement = jest.fn((tagName: string) => {
      if (tagName === 'video') return video;
      return originalCreateElement(tagName as any);
    }) as any;

    const originalArtifact = {
      filename: 'tab.webm',
      file: new File(['original'], 'tab.webm', { type: 'video/webm' }),
      cleanup: jest.fn().mockResolvedValue(undefined),
    };

    const processed = await postprocessVideoArtifact(
      originalArtifact,
      {
        stream: 'tab',
        outputContainer: 'webm',
        outputTarget: { width: 640, height: 360, frameRate: 24 },
      },
      {
        log: jest.fn(),
        warn: jest.fn(),
      }
    );

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0].start).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances[0].stop).toHaveBeenCalledTimes(1);
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(processed.filename).toBe('tab.webm');
    expect(await toText(processed.file)).toBe('processed');
    expect(originalArtifact.cleanup).toHaveBeenCalledTimes(1);
    expect(cleanupResized).toHaveBeenCalledTimes(1);
  });
});
