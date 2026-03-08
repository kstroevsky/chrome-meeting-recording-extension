import { RecorderEngine, type SealedStorageFile, type StorageTarget } from '../src/offscreen/RecorderEngine';
import { PERF_FLAGS, resetPerfFlags } from '../src/shared/perf';

function chunk(text: string, type = 'video/webm'): Blob {
  return new Blob([text], { type });
}

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
    muted: false,
    enabled: true,
    stop: jest.fn(),
    addEventListener: jest.fn(),
    getSettings: () => settings ?? {},
  };
}

function makeStream(options: {
  audioTracks?: any[];
  videoTracks?: any[];
}): MediaStream {
  const audioTracks = options.audioTracks ?? [];
  const videoTracks = options.videoTracks ?? [];
  return {
    getAudioTracks: () => audioTracks,
    getVideoTracks: () => videoTracks,
    getTracks: () => [...audioTracks, ...videoTracks],
  } as any;
}

class BufferedTarget implements StorageTarget {
  private readonly chunks: Blob[] = [];
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly filename: string,
    private readonly mimeType: string,
    private readonly writeDelayMs = 0
  ) {}

  async write(blob: Blob): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (this.writeDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
      }
      this.chunks.push(blob);
    });
    return await this.pending;
  }

  async close(): Promise<SealedStorageFile | null> {
    await this.pending;
    return {
      filename: this.filename,
      file: new File([new Blob(this.chunks, { type: this.mimeType })], this.filename, {
        type: this.mimeType,
      }),
      cleanup: async () => {},
    };
  }
}

class FakeMediaRecorder {
  static isTypeSupported = jest.fn().mockReturnValue(true);
  static instances: FakeMediaRecorder[] = [];
  static stopPayloadByKind: Record<string, string> = {
    tab: 'tab',
    mic: 'mic',
    selfVideo: 'selfVideo',
  };

  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  state = 'inactive';
  timesliceMs: number | undefined;
  readonly kind: 'tab' | 'mic' | 'selfVideo' | 'unknown';

  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions
  ) {
    const hasAudio = stream.getAudioTracks().length > 0;
    const hasVideo = stream.getVideoTracks().length > 0;
    this.kind = hasAudio && hasVideo ? 'tab' : hasAudio ? 'mic' : hasVideo ? 'selfVideo' : 'unknown';
    FakeMediaRecorder.instances.push(this);
  }

  start = jest.fn((timesliceMs?: number) => {
    this.timesliceMs = timesliceMs;
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  });

  stop = jest.fn(() => {
    this.state = 'inactive';
    queueMicrotask(() => {
      const payload = FakeMediaRecorder.stopPayloadByKind[this.kind];
      if (payload) {
        this.ondataavailable?.({ data: chunk(payload, this.options.mimeType || 'video/webm') } as BlobEvent);
      }
      this.onstop?.();
    });
  });
}

describe('RecorderEngine', () => {
  let deps: any;
  let engine: RecorderEngine;
  let originalMediaRecorder: typeof MediaRecorder;

  beforeEach(() => {
    originalMediaRecorder = global.MediaRecorder as any;
    (global as any).MediaRecorder = FakeMediaRecorder as any;
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.stopPayloadByKind = {
      tab: 'tab',
      mic: 'mic',
      selfVideo: 'selfVideo',
    };
    resetPerfFlags();

    deps = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      notifyPhase: jest.fn(),
      enableMicMix: false,
    };
    engine = new RecorderEngine(deps);
  });

  afterEach(() => {
    (global as any).MediaRecorder = originalMediaRecorder;
    resetPerfFlags();
  });

  it('starts as idle and isRecording() is false', () => {
    expect(engine.isRecording()).toBe(false);
  });

  it('returns an empty result if stopped while not recording', async () => {
    await expect(engine.stop()).resolves.toEqual([]);
    expect(deps.warn).toHaveBeenCalledWith('Stop called but not recording');
  });

  it('falls back to in-memory storage when local target creation fails', async () => {
    deps.openTarget = jest.fn().mockRejectedValue(new Error('OPFS unavailable'));
    engine = new RecorderEngine(deps);

    const target = await (engine as any).openStorageTarget('test.webm', 'video/webm');
    await target.write(chunk('abc'));
    const artifact = await target.close();

    expect(deps.warn).toHaveBeenCalledWith(
      'Failed to open storage target, falling back to RAM buffer',
      expect.stringContaining('OPFS unavailable')
    );
    expect(artifact?.filename).toBe('test.webm');
    expect(await toText(artifact?.file)).toBe('abc');
  });

  it('notifies recording phase only when the first recorder starts', () => {
    (engine as any).onRecorderStarted();
    (engine as any).onRecorderStarted();

    expect(deps.notifyPhase).toHaveBeenCalledTimes(1);
    expect(deps.notifyPhase).toHaveBeenCalledWith('recording');
  });

  it('resolves the pending stop promise when the last recorder stops', () => {
    const artifact = {
      filename: 'test.webm',
      file: chunk('x'),
      cleanup: jest.fn().mockResolvedValue(undefined),
    };
    const resolveStop = jest.fn();

    (engine as any).activeRecorders = 1;
    (engine as any).resolveStop = resolveStop;
    (engine as any).stopPromise = Promise.resolve([]);
    (engine as any).finalizedArtifacts = [{ stream: 'tab', artifact }];

    (engine as any).onRecorderStopped();

    expect(resolveStop).toHaveBeenCalledWith([{ stream: 'tab', artifact }]);
    expect((engine as any).finalizedArtifacts).toEqual([]);
    expect(engine.isRecording()).toBe(false);
  });

  it('waits for target close() to drain pending writes without dropping chunks', async () => {
    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string) => new BufferedTarget(filename, 'video/webm', 10));
    FakeMediaRecorder.stopPayloadByKind.tab = '';

    await engine.startFromStreamId('stream-id');
    const recorder = FakeMediaRecorder.instances[0];

    recorder.ondataavailable?.({ data: chunk('part-1') } as BlobEvent);
    recorder.ondataavailable?.({ data: chunk('part-2') } as BlobEvent);

    const artifacts = await engine.stop();

    expect(artifacts).toHaveLength(1);
    expect(await toText(artifacts[0].artifact.file)).toBe('part-1part-2');
  });

  it('finalizes tab, mic, and self-video artifacts in one stop flow', async () => {
    deps.enableMicMix = true;
    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    const micStream = makeStream({
      audioTracks: [makeTrack('audio')],
    });
    const selfVideoStream = makeStream({
      videoTracks: [makeTrack('video', { width: 1280, height: 720, frameRate: 30 })],
    });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.audio && !constraints.video) return micStream;
      if (constraints.video && constraints.audio === false) return selfVideoStream;
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', {
      recordSelfVideo: true,
      selfVideoQuality: 'high',
    });

    const artifacts = await engine.stop();
    const byStream = Object.fromEntries(
      await Promise.all(
        artifacts.map(async ({ stream, artifact }) => [stream, await toText(artifact.file)])
      )
    );

    expect(artifacts.map((entry) => entry.stream).sort()).toEqual(['mic', 'selfVideo', 'tab']);
    expect(byStream).toEqual({
      tab: 'tab',
      mic: 'mic',
      selfVideo: 'selfVideo',
    });
  });

  it('uses the extended timeslice only when the feature flag is enabled', async () => {
    PERF_FLAGS.extendedTimeslice = true;
    deps.enableMicMix = true;

    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.audio && !constraints.video) {
        return makeStream({ audioTracks: [makeTrack('audio')] });
      }
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id');

    expect(FakeMediaRecorder.instances[0].timesliceMs).toBe(4000);
  });
});
