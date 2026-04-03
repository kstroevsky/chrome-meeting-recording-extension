import { RecorderEngine, type SealedStorageFile, type StorageTarget } from '../src/offscreen/RecorderEngine';
import { openStorageTarget } from '../src/offscreen/engine/RecorderTaskUtils';
import {
  buildRecorderRuntimeSettingsSnapshot,
  normalizeExtensionSettings,
  resetExtensionSettingsToDefaults,
  saveExtensionSettingsToStorage,
} from '../src/shared/extensionSettings';
import { PERF_FLAGS, resetPerfFlags } from '../src/shared/perf';
import type { RecordingRunConfig } from '../src/shared/recording';

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

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

function makeRunConfig(overrides: Partial<RecordingRunConfig> = {}): RecordingRunConfig {
  return {
    storageMode: 'local',
    micMode: 'off',
    recordSelfVideo: false,
    ...overrides,
  };
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
    'self-video': 'self-video',
  };

  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  state = 'inactive';
  timesliceMs: number | undefined;
  readonly kind: 'tab' | 'mic' | 'self-video' | 'unknown';

  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions
  ) {
    const hasAudio = stream.getAudioTracks().length > 0;
    const hasVideo = stream.getVideoTracks().length > 0;
    this.kind = hasAudio && hasVideo ? 'tab' : hasAudio ? 'mic' : hasVideo ? 'self-video' : 'unknown';
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
  let originalAudioContext: typeof AudioContext | undefined;
  let originalMediaStream: typeof MediaStream | undefined;
  let originalCreateElement: typeof document.createElement;

  function installResizerDom(options: {
    sourceWidth: number;
    sourceHeight: number;
    outputWidth: number;
    outputHeight: number;
    outputFrameRate: number;
  }) {
    const outputVideoTrack = makeTrack('video', {
      width: options.outputWidth,
      height: options.outputHeight,
      frameRate: options.outputFrameRate,
    });
    const captureStream = makeStream({
      videoTracks: [outputVideoTrack],
    });
    const drawImage = jest.fn();
    const video = {
      srcObject: null,
      muted: false,
      playsInline: false,
      autoplay: false,
      hidden: false,
      style: {},
      videoWidth: options.sourceWidth,
      videoHeight: options.sourceHeight,
      play: jest.fn().mockResolvedValue(undefined),
      pause: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as any;
    const canvas = {
      width: 0,
      height: 0,
      hidden: false,
      style: {},
      getContext: jest.fn(() => ({
        drawImage,
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
      })),
      captureStream: jest.fn(() => captureStream),
    } as any;

    document.createElement = jest.fn((tagName: string) => {
      if (tagName === 'video') return video;
      if (tagName === 'canvas') return canvas;
      return originalCreateElement(tagName as any);
    }) as any;

    return {
      canvas,
      drawImage,
      outputVideoTrack,
      video,
    };
  }

  beforeEach(async () => {
    originalMediaRecorder = global.MediaRecorder as any;
    originalAudioContext = (global as any).AudioContext;
    originalMediaStream = (global as any).MediaStream;
    originalCreateElement = document.createElement.bind(document);
    (global as any).MediaRecorder = FakeMediaRecorder as any;
    (global as any).MediaStream = class {
      constructor(public readonly tracks: any[] = []) {}
      getTracks() { return this.tracks; }
      getAudioTracks() { return this.tracks.filter((track) => track?.kind === 'audio'); }
      getVideoTracks() { return this.tracks.filter((track) => track?.kind === 'video'); }
    } as any;
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.stopPayloadByKind = {
      tab: 'tab',
      mic: 'mic',
      'self-video': 'self-video',
    };
    resetPerfFlags();

    deps = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      notifyPhase: jest.fn(),
      reportWarning: jest.fn(),
      enableMicMix: false,
    };
    engine = new RecorderEngine(deps);
    await resetExtensionSettingsToDefaults();
  });

  afterEach(async () => {
    (global as any).MediaRecorder = originalMediaRecorder;
    (global as any).AudioContext = originalAudioContext;
    (global as any).MediaStream = originalMediaStream;
    document.createElement = originalCreateElement;
    resetPerfFlags();
    await resetExtensionSettingsToDefaults();
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

    const target = await openStorageTarget('test.webm', 'video/webm', deps);
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

    await engine.startFromStreamId('stream-id', makeRunConfig());
    const recorder = FakeMediaRecorder.instances[0];

    recorder.ondataavailable?.({ data: chunk('part-1') } as BlobEvent);
    recorder.ondataavailable?.({ data: chunk('part-2') } as BlobEvent);

    const artifacts = await engine.stop();

    expect(artifacts).toHaveLength(1);
    expect(await toText(artifacts[0].artifact.file)).toBe('part-1part-2');
  });

  it('finalizes tab, mic, and self-video artifacts in one stop flow', async () => {
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

    await engine.startFromStreamId('stream-id', makeRunConfig({
      micMode: 'separate',
      recordSelfVideo: true,
    }));
    await flushAsyncWork();

    const artifacts = await engine.stop();
    const byStream = Object.fromEntries(
      await Promise.all(
        artifacts.map(async ({ stream, artifact }) => [stream, await toText(artifact.file)])
      )
    );

    expect(artifacts.map((entry) => entry.stream).sort()).toEqual(['mic', 'self-video', 'tab']);
    expect(byStream).toEqual({
      tab: 'tab',
      mic: 'mic',
      'self-video': 'self-video',
    });
  });

  it('releases the self-video track immediately when stop is requested', async () => {
    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    const selfVideoTrack = makeTrack('video', { width: 1280, height: 720, frameRate: 30 });
    const selfVideoStream = makeStream({
      videoTracks: [selfVideoTrack],
    });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.video && constraints.audio === false) return selfVideoStream;
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig({ recordSelfVideo: true }));
    await flushAsyncWork();

    const stopPromise = engine.stop();
    expect(selfVideoTrack.stop).toHaveBeenCalledTimes(1);

    await stopPromise;
    expect(selfVideoTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('mixes microphone audio into the tab recording when micMode=mixed', async () => {
    const createMediaStreamSource = jest.fn().mockReturnValue({ connect: jest.fn() });
    const mixedAudioTrack = makeTrack('audio');
    const createMediaStreamDestination = jest.fn().mockReturnValue({
      stream: makeStream({ audioTracks: [mixedAudioTrack] }),
    });
    const audioContextCtor = jest.fn().mockImplementation(() => ({
      resume: jest.fn().mockResolvedValue(undefined),
      createMediaStreamSource,
      createMediaStreamDestination,
      destination: {},
      close: jest.fn(),
    }));
    (global as any).AudioContext = audioContextCtor;

    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    const micStream = makeStream({
      audioTracks: [makeTrack('audio')],
    });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.audio && !constraints.video) return micStream;
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig({ micMode: 'mixed' }));
    const artifacts = await engine.stop();

    expect(createMediaStreamDestination).toHaveBeenCalledTimes(1);
    expect(artifacts.map((entry) => entry.stream)).toEqual(['tab']);
    expect(await toText(artifacts[0].artifact.file)).toBe('tab');
  });

  it('records the original tab stream directly using the frozen capture ceiling', async () => {
    const baseAudioTrack = makeTrack('audio', { suppressLocalAudioPlayback: false });
    const baseStream = makeStream({
      audioTracks: [baseAudioTrack],
      videoTracks: [makeTrack('video', { width: 1920, height: 1080, frameRate: 30 })],
    });
    const recorderSettings = buildRecorderRuntimeSettingsSnapshot(normalizeExtensionSettings({
      professional: {
        tabResolutionPreset: '640x360',
        tabMaxFrameRate: 24,
      },
    }));
    const createElementSpy = jest.fn((tagName: string) => originalCreateElement(tagName as any));
    document.createElement = createElementSpy as any;

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig(), recorderSettings);

    const tabRecorder = FakeMediaRecorder.instances.find((instance) => instance.kind === 'tab');
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({
          mandatory: expect.objectContaining({
            maxWidth: 640,
            maxHeight: 360,
            maxFrameRate: 24,
          }),
        }),
      })
    );
    expect(tabRecorder?.stream).toBe(baseStream);
    expect(createElementSpy).not.toHaveBeenCalled();

    await engine.stop();
  });

  it('preserves mixed microphone audio without introducing a resize stream', async () => {
    await saveExtensionSettingsToStorage({
      professional: {
        tabResolutionPreset: '640x360',
        tabMaxFrameRate: 24,
      },
    });

    const createMediaStreamSource = jest.fn().mockReturnValue({ connect: jest.fn() });
    const mixedAudioTrack = makeTrack('audio');
    const createMediaStreamDestination = jest.fn().mockReturnValue({
      stream: makeStream({ audioTracks: [mixedAudioTrack] }),
    });
    const audioContextCtor = jest.fn().mockImplementation(() => ({
      resume: jest.fn().mockResolvedValue(undefined),
      createMediaStreamSource,
      createMediaStreamDestination,
      destination: {},
      close: jest.fn(),
    }));
    (global as any).AudioContext = audioContextCtor;

    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video', { width: 1920, height: 1080, frameRate: 30 })],
    });
    const micStream = makeStream({
      audioTracks: [makeTrack('audio')],
    });
    const baseVideoTrack = baseStream.getVideoTracks()[0];
    const createElementSpy = jest.fn((tagName: string) => originalCreateElement(tagName as any));
    document.createElement = createElementSpy as any;

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.audio && !constraints.video) return micStream;
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig({ micMode: 'mixed' }));

    const tabRecorder = FakeMediaRecorder.instances.find((instance) => instance.kind === 'tab');
    expect(tabRecorder?.stream.getVideoTracks()).toEqual([baseVideoTrack]);
    expect(tabRecorder?.stream.getAudioTracks()).toEqual([mixedAudioTrack]);
    expect(createElementSpy).not.toHaveBeenCalled();

    await engine.stop();
  });

  it('keeps the tab recorder on the default cadence when the mic recorder uses extended chunks', async () => {
    PERF_FLAGS.extendedTimeslice = true;

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

    await engine.startFromStreamId('stream-id', makeRunConfig({ micMode: 'separate' }));

    const tabRecorder = FakeMediaRecorder.instances.find((instance) => instance.kind === 'tab');
    const micRecorder = FakeMediaRecorder.instances.find((instance) => instance.kind === 'mic');
    expect(tabRecorder?.timesliceMs).toBe(4000);
    expect(micRecorder?.timesliceMs).toBe(4000);
  });

  it('keeps the default tab and mic cadence when the extended flag is off', async () => {
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

    await engine.startFromStreamId('stream-id', makeRunConfig({ micMode: 'separate' }));

    const tabRecorder = FakeMediaRecorder.instances.find((instance) => instance.kind === 'tab');
    const micRecorder = FakeMediaRecorder.instances.find((instance) => instance.kind === 'mic');
    expect(tabRecorder?.timesliceMs).toBe(4000);
    expect(micRecorder?.timesliceMs).toBe(2000);
  });

  it('uses the longer timeslice for self-video while keeping the tab recorder on its normal extended cadence', async () => {
    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    const selfVideoStream = makeStream({
      videoTracks: [makeTrack('video', { width: 640, height: 360, frameRate: 30 })],
    });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.video && constraints.audio === false) {
        return selfVideoStream;
      }
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig({ recordSelfVideo: true }));
    await flushAsyncWork();

    const tabRecorder = FakeMediaRecorder.instances.find((instance) => instance.kind === 'tab');
    const selfVideoRecorder = FakeMediaRecorder.instances.find((instance) => instance.kind === 'self-video');
    expect(tabRecorder?.timesliceMs).toBe(4000);
    expect(selfVideoRecorder?.timesliceMs).toBe(4000);
  });

  it('skips the audio playback bridge in auto mode when local tab audio is not suppressed', async () => {
    PERF_FLAGS.audioPlaybackBridgeMode = 'auto';
    const createMediaStreamSource = jest.fn().mockReturnValue({ connect: jest.fn() });
    const audioContextCtor = jest.fn().mockImplementation(() => ({
      resume: jest.fn().mockResolvedValue(undefined),
      createMediaStreamSource,
      destination: {},
      close: jest.fn(),
    }));
    (global as any).AudioContext = audioContextCtor;

    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig());

    expect(audioContextCtor).not.toHaveBeenCalled();
  });

  it('preserves always mode parity when the suppression flag is missing', async () => {
    PERF_FLAGS.audioPlaybackBridgeMode = 'always';
    const connect = jest.fn();
    const createMediaStreamSource = jest.fn().mockReturnValue({ connect });
    const audioContextCtor = jest.fn().mockImplementation(() => ({
      resume: jest.fn().mockResolvedValue(undefined),
      createMediaStreamSource,
      destination: {},
      close: jest.fn(),
    }));
    (global as any).AudioContext = audioContextCtor;

    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', {})],
      videoTracks: [makeTrack('video')],
    });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig());

    expect(audioContextCtor).toHaveBeenCalledTimes(1);
    expect(createMediaStreamSource).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('uses capability-aware self video bitrate ceilings when adaptive profiling is enabled', async () => {
    PERF_FLAGS.adaptiveSelfVideoProfile = true;
    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    const selfVideoStream = makeStream({
      videoTracks: [makeTrack('video', { width: 640, height: 360, frameRate: 15 })],
    });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.video && constraints.audio === false) return selfVideoStream;
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig({
      recordSelfVideo: true,
    }));
    await flushAsyncWork();

    const selfVideoRecorder = FakeMediaRecorder.instances.find((instance) => instance.kind === 'self-video');
    expect(selfVideoRecorder?.options.videoBitsPerSecond).toBe(1_000_000);
    expect(deps.reportWarning).toHaveBeenCalledWith(
      expect.stringContaining('Camera recording requested 1920x1080@30fps, but browser delivered 640x360@15fps.')
    );
  });
});
