import { RecorderEngine, type SealedStorageFile, type StorageTarget } from '../src/offscreen/RecorderEngine';
import { openStorageTarget } from '../src/offscreen/engine/RecorderTaskUtils';
import {
  buildRecorderRuntimeSettingsSnapshot,
  normalizeExtensionSettings,
  resetExtensionSettingsToDefaults,
  saveExtensionSettingsToStorage,
} from '../src/shared/settings';
import {
  configurePerfRuntime,
  PERF_FLAGS,
  resetPerfFlags,
  type PerfEventEntry,
} from '../src/shared/perf';
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

  pause = jest.fn(() => { this.state = 'paused'; });
  resume = jest.fn(() => { this.state = 'recording'; });
}

describe('RecorderEngine', () => {
  let deps: any;
  let engine: RecorderEngine;
  let originalMediaRecorder: typeof MediaRecorder;
  let originalAudioContext: typeof AudioContext | undefined;
  let originalMediaStream: typeof MediaStream | undefined;
  let originalCreateElement: typeof document.createElement;

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
    (globalThis as any).__DEV_BUILD__ = false;
    document.createElement = originalCreateElement;
    resetPerfFlags();
    await resetExtensionSettingsToDefaults();
  });

  it('starts as idle and isRecording() is false', () => {
    expect(engine.isRecording()).toBe(false);
  });

  it('measures recorder start latency with one monotonic clock', async () => {
    (globalThis as any).__DEV_BUILD__ = true;
    const events: PerfEventEntry[] = [];
    await configurePerfRuntime({
      source: 'offscreen',
      sink: (entry) => { events.push(entry); },
    });
    const nowSpy = jest.spyOn(performance, 'now');
    nowSpy
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125)
      .mockReturnValue(130);

    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    (navigator.mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(baseStream);
    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) =>
      new BufferedTarget(filename, mimeType || 'video/webm')
    );

    await engine.startFromStreamId('stream-id', makeRunConfig());

    const started = events.find(
      (entry) => entry.scope === 'recorder' && entry.event === 'recorder_started'
    );
    expect(started?.fields.latencyMs).toEqual(expect.any(Number));
    expect(started!.fields.latencyMs as number).toBeGreaterThanOrEqual(0);
    expect(started!.fields.latencyMs as number).toBeLessThan(1_000);

    await engine.stop();
    (globalThis as any).__DEV_BUILD__ = false;
  });

  it('returns an empty result if stopped while not recording', async () => {
    await expect(engine.stop()).resolves.toEqual([]);
    expect(deps.warn).toHaveBeenCalledWith('Stop called but not recording');
  });

  it('notifies the recording phase exactly once even when several recorders start', async () => {
    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.audio && !constraints.video) return makeStream({ audioTracks: [makeTrack('audio')] });
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig({ micMode: 'separate' }));
    await flushAsyncWork();

    expect(engine.getActiveRecorderCount()).toBe(2);
    expect(deps.notifyPhase).toHaveBeenCalledTimes(1);
    expect(deps.notifyPhase).toHaveBeenCalledWith('recording');

    await engine.stop();
  });

  it('returns to idle once the last recorder stops and is ready for a new run', async () => {
    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.audio && !constraints.video) return makeStream({ audioTracks: [makeTrack('audio')] });
      throw new Error('Unexpected getUserMedia call');
    });

    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig({ micMode: 'separate' }));
    await flushAsyncWork();
    expect(engine.isRecording()).toBe(true);
    expect(engine.getActiveRecorderCount()).toBe(2);

    const artifacts = await engine.stop();

    expect(artifacts.map((entry) => entry.stream).sort()).toEqual(['mic', 'tab']);
    expect(engine.isRecording()).toBe(false);
    expect(engine.getActiveRecorderCount()).toBe(0);
    expect(engine.getDebugState()).toBe('idle');

    // The run fully resolved, so a redundant stop is a clean no-op...
    await expect(engine.stop()).resolves.toEqual([]);

    // ...and the cleared track set lets a fresh run start.
    await engine.startFromStreamId('stream-id', makeRunConfig());
    await flushAsyncWork();
    expect(engine.isRecording()).toBe(true);
    await engine.stop();
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

  it('stops only the offending optional stream when its RAM buffer overflows, and keeps recording the tab', async () => {
    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    const selfVideoTrack = makeTrack('video', { width: 1280, height: 720, frameRate: 30 });
    const selfVideoStream = makeStream({ videoTracks: [selfVideoTrack] });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.video && constraints.audio === false) return selfVideoStream;
      throw new Error('Unexpected getUserMedia call');
    });

    // OPFS opens for tab but fails for self-video, forcing self-video onto a RAM buffer.
    deps.openTarget = jest.fn(async (filename: string, stream?: string) => {
      if (stream === 'self-video') throw new Error('OPFS unavailable');
      return new BufferedTarget(filename, 'video/webm');
    });

    await engine.startFromStreamId('stream-id', makeRunConfig({ recordSelfVideo: true }));
    await flushAsyncWork();

    const tabRecorder = FakeMediaRecorder.instances.find((i) => i.kind === 'tab');
    const selfVideoRecorder = FakeMediaRecorder.instances.find((i) => i.kind === 'self-video');
    expect(tabRecorder).toBeDefined();
    expect(selfVideoRecorder).toBeDefined();

    // Fill the self-video RAM buffer past its 512 MB cap with 60 MB chunks — each
    // stays under the 64 MB soft-warn and 256 MB hard-ceiling pending thresholds,
    // and draining between writes keeps only one in flight, so the RAM-size cap is
    // the only backstop that trips (not the slow-disk backpressure escalation).
    for (let i = 0; i < 9; i++) {
      selfVideoRecorder!.ondataavailable?.(
        { data: { size: 60 * 1024 * 1024, type: 'video/webm' } } as unknown as BlobEvent
      );
      await flushAsyncWork();
    }

    // Only the self-video recorder was stopped; the required tab stream keeps running.
    expect(selfVideoRecorder!.stop).toHaveBeenCalledTimes(1);
    expect(tabRecorder!.stop).not.toHaveBeenCalled();
    expect(selfVideoTrack.stop).toHaveBeenCalledTimes(1); // camera source released
    expect(engine.isRecording()).toBe(true);
    expect(deps.reportWarning).toHaveBeenCalledWith(expect.stringMatching(/stopping just this stream/));

    // The partial self-video artifact is still delivered at the eventual session stop.
    const artifacts = await engine.stop();
    expect(artifacts.map((a: { stream: string }) => a.stream).sort()).toEqual(['self-video', 'tab']);
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
    // 640x360@24 scales the tab bitrate below the floor → clamped to 250 kbps.
    expect(tabRecorder?.options.videoBitsPerSecond).toBe(250_000);
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
    (globalThis as any).__DEV_BUILD__ = true;
    const events: PerfEventEntry[] = [];
    await configurePerfRuntime({
      source: 'offscreen',
      sink: (entry) => { events.push(entry); },
    });
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
    expect(events).toContainEqual(expect.objectContaining({
      scope: 'recorder',
      event: 'tab_audio_bridge_check',
      fields: expect.objectContaining({
        mode: 'auto',
        hasAudioTrack: true,
        suppressLocalAudioPlayback: false,
        willBridge: false,
      }),
    }));
    (globalThis as any).__DEV_BUILD__ = false;
  });

  it('preserves always mode parity when the suppression flag is missing', async () => {
    (globalThis as any).__DEV_BUILD__ = true;
    const events: PerfEventEntry[] = [];
    await configurePerfRuntime({
      source: 'offscreen',
      sink: (entry) => { events.push(entry); },
    });
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
    expect(events).toContainEqual(expect.objectContaining({
      scope: 'recorder',
      event: 'tab_audio_bridge_check',
      fields: expect.objectContaining({
        mode: 'always',
        hasAudioTrack: true,
        suppressLocalAudioPlayback: null,
        willBridge: true,
      }),
    }));
    (globalThis as any).__DEV_BUILD__ = false;
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

  it('mutes and unmutes the live microphone by toggling the mic track (separate mode)', async () => {
    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    const micTrack = makeTrack('audio');
    const micStream = makeStream({ audioTracks: [micTrack] });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.audio && !constraints.video) return micStream;
      throw new Error('Unexpected getUserMedia call');
    });
    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig({ micMode: 'separate' }));
    await flushAsyncWork();

    // Silence-in-place: the track stays live (never stopped) but emits silence.
    expect(micTrack.enabled).toBe(true);
    engine.setMicMuted(true);
    expect(micTrack.enabled).toBe(false);
    expect(micTrack.stop).not.toHaveBeenCalled();
    engine.setMicMuted(false);
    expect(micTrack.enabled).toBe(true);

    await engine.stop();
  });

  it('mutes the microphone feeding the mixed tab recording', async () => {
    const createMediaStreamSource = jest.fn().mockReturnValue({ connect: jest.fn() });
    const createMediaStreamDestination = jest.fn().mockReturnValue({
      stream: makeStream({ audioTracks: [makeTrack('audio')] }),
    });
    (global as any).AudioContext = jest.fn().mockImplementation(() => ({
      resume: jest.fn().mockResolvedValue(undefined),
      createMediaStreamSource,
      createMediaStreamDestination,
      destination: {},
      close: jest.fn(),
    }));

    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    const micTrack = makeTrack('audio');
    const micStream = makeStream({ audioTracks: [micTrack] });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.audio && !constraints.video) return micStream;
      throw new Error('Unexpected getUserMedia call');
    });
    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig({ micMode: 'mixed' }));

    engine.setMicMuted(true);
    expect(micTrack.enabled).toBe(false);

    await engine.stop();
  });

  it('treats mic mute as a safe no-op for a tab-only recording', async () => {
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
    expect(() => engine.setMicMuted(true)).not.toThrow();

    await engine.stop();
  });

  it('hides and shows the live camera by toggling the self-video track to black frames', async () => {
    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    const selfVideoTrack = makeTrack('video', { width: 1280, height: 720, frameRate: 30 });
    const selfVideoStream = makeStream({ videoTracks: [selfVideoTrack] });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.video && constraints.audio === false) return selfVideoStream;
      throw new Error('Unexpected getUserMedia call');
    });
    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig({ recordSelfVideo: true }));
    await flushAsyncWork();

    // Black-frames-in-place: the camera track stays live (never stopped) but is disabled.
    expect(selfVideoTrack.enabled).toBe(true);
    engine.setCameraMuted(true);
    expect(selfVideoTrack.enabled).toBe(false);
    expect(selfVideoTrack.stop).not.toHaveBeenCalled();
    engine.setCameraMuted(false);
    expect(selfVideoTrack.enabled).toBe(true);

    await engine.stop();
  });

  it('treats camera hide as a safe no-op when no camera is recording', async () => {
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
    expect(() => engine.setCameraMuted(true)).not.toThrow();

    await engine.stop();
  });

  it('pauses and resumes every active recorder so the paused span is never written', async () => {
    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    const micTrack = makeTrack('audio');
    const micStream = makeStream({ audioTracks: [micTrack] });
    const selfVideoStream = makeStream({ videoTracks: [makeTrack('video', { width: 1280, height: 720, frameRate: 30 })] });

    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.audio && !constraints.video) return micStream;
      if (constraints.video && constraints.audio === false) return selfVideoStream;
      throw new Error('Unexpected getUserMedia call');
    });
    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig({ micMode: 'separate', recordSelfVideo: true }));
    await flushAsyncWork();

    const recorders = FakeMediaRecorder.instances;
    expect(recorders.length).toBeGreaterThanOrEqual(2);
    expect(recorders.every((r) => r.state === 'recording')).toBe(true);

    engine.setPaused(true);
    expect(recorders.every((r) => r.state === 'paused')).toBe(true);
    expect(recorders.every((r) => (r.pause as jest.Mock).mock.calls.length === 1)).toBe(true);
    // Tracks stay live across the pause so resume is seamless.
    expect(micTrack.stop).not.toHaveBeenCalled();

    engine.setPaused(false);
    expect(recorders.every((r) => r.state === 'recording')).toBe(true);
    expect(recorders.every((r) => (r.resume as jest.Mock).mock.calls.length === 1)).toBe(true);

    await engine.stop();
  });

  it('does not pause/resume a recorder that is not in the matching state (no InvalidStateError)', async () => {
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
    const tab = FakeMediaRecorder.instances[0];

    // Resume while already recording is a no-op.
    engine.setPaused(false);
    expect(tab.resume).not.toHaveBeenCalled();

    // Double pause only pauses once.
    engine.setPaused(true);
    engine.setPaused(true);
    expect((tab.pause as jest.Mock).mock.calls.length).toBe(1);

    await engine.stop();
  });

  it('applies a pause toggled during the starting phase to recorders as they register', async () => {
    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      throw new Error('Unexpected getUserMedia call');
    });
    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    // Toggle pause before any recorder has registered, then let the start finish.
    const starting = engine.startFromStreamId('stream-id', makeRunConfig());
    engine.setPaused(true);
    await starting;
    await flushAsyncWork();

    const tab = FakeMediaRecorder.instances[0];
    expect(tab.state).toBe('paused');
    expect(tab.pause).toHaveBeenCalled();

    await engine.stop();
  });

  it('suspends and resumes the mixed-audio context across a pause', async () => {
    const suspend = jest.fn().mockResolvedValue(undefined);
    const resume = jest.fn().mockResolvedValue(undefined);
    (global as any).AudioContext = jest.fn().mockImplementation(() => ({
      resume,
      suspend,
      createMediaStreamSource: jest.fn().mockReturnValue({ connect: jest.fn(), disconnect: jest.fn() }),
      createMediaStreamDestination: jest.fn().mockReturnValue({ stream: makeStream({ audioTracks: [makeTrack('audio')] }) }),
      destination: {},
      close: jest.fn(),
    }));

    const baseStream = makeStream({
      audioTracks: [makeTrack('audio', { suppressLocalAudioPlayback: false })],
      videoTracks: [makeTrack('video')],
    });
    const micStream = makeStream({ audioTracks: [makeTrack('audio')] });
    (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async (constraints: MediaStreamConstraints) => {
      if ((constraints.video as any)?.mandatory?.chromeMediaSource) return baseStream;
      if (constraints.audio && !constraints.video) return micStream;
      throw new Error('Unexpected getUserMedia call');
    });
    deps.openTarget = jest.fn(async (filename: string, mimeType?: string) => new BufferedTarget(filename, mimeType || 'video/webm'));

    await engine.startFromStreamId('stream-id', makeRunConfig({ micMode: 'mixed' }));
    await flushAsyncWork();
    suspend.mockClear();
    resume.mockClear();

    engine.setPaused(true);
    expect(suspend).toHaveBeenCalledTimes(1);

    engine.setPaused(false);
    expect(resume).toHaveBeenCalledTimes(1);

    await engine.stop();
  });
});

// openStorageTarget is a RecorderTaskUtils helper, not part of the engine facade;
// kept in its own describe so its behavior is not framed as engine state-machine logic.
describe('openStorageTarget (RecorderTaskUtils)', () => {
  it('falls back to an in-memory RAM buffer when the local target cannot be opened', async () => {
    const deps = {
      warn: jest.fn(),
      openTarget: jest.fn().mockRejectedValue(new Error('OPFS unavailable')),
    } as any;

    const target = await openStorageTarget('test.webm', 'video/webm', deps);
    await target.write(chunk('abc'));
    const artifact = await target.close();

    expect(deps.warn).toHaveBeenCalledWith(
      'Failed to open storage target for recording, falling back to RAM buffer',
      expect.stringContaining('OPFS unavailable')
    );
    expect(artifact?.filename).toBe('test.webm');
    expect(await toText(artifact?.file)).toBe('abc');
  });
});
