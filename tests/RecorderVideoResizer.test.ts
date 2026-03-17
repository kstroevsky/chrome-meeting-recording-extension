import {
  createResizedVideoStream,
  type RecorderVideoResizerDeps,
} from '../src/offscreen/RecorderVideoResizer';

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

describe('RecorderVideoResizer', () => {
  it('creates a resized stream at the requested dimensions and preserves audio tracks', async () => {
    const sourceAudioTrack = makeTrack('audio');
    const sourceVideoTrack = makeTrack('video', { width: 1920, height: 1080, frameRate: 30 });
    const sourceStream = makeStream([sourceAudioTrack, sourceVideoTrack]);
    const outputVideoTrack = makeTrack('video', { width: 640, height: 360, frameRate: 24 });
    const captureStream = makeStream([outputVideoTrack]);
    const drawImage = jest.fn();
    const video = {
      srcObject: null,
      muted: false,
      playsInline: false,
      autoplay: false,
      hidden: false,
      style: {},
      videoWidth: 1920,
      videoHeight: 1080,
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
    const createMediaStream = jest.fn((tracks: MediaStreamTrack[]) => makeStream(tracks as any[]));
    let scheduledFrame: (() => void) | undefined;
    const setTimeout = jest.fn((callback: () => void) => {
      scheduledFrame = callback;
      return 7 as any;
    });
    const clearTimeout = jest.fn();
    const deps: RecorderVideoResizerDeps = {
      document: {
        createElement: jest.fn((tagName: 'video' | 'canvas') => (tagName === 'video' ? video : canvas)),
      },
      createMediaStream,
      setTimeout: setTimeout as any,
      clearTimeout: clearTimeout as any,
    };

    const result = await createResizedVideoStream(sourceStream, {
      width: 640,
      height: 360,
      frameRate: 24,
    }, deps);

    expect(result.resized).toBe(true);
    expect(result.stream.getVideoTracks()).toEqual([outputVideoTrack]);
    expect(result.stream.getAudioTracks()).toEqual([sourceAudioTrack]);
    expect(result.output).toEqual({
      width: 640,
      height: 360,
      frameRate: 24,
    });
    expect(canvas.captureStream).toHaveBeenCalledWith(24);
    expect(createMediaStream).toHaveBeenCalledWith([outputVideoTrack, sourceAudioTrack]);
    expect(drawImage).toHaveBeenCalledTimes(1);

    expect(scheduledFrame).toBeDefined();
    scheduledFrame?.();
    expect(drawImage).toHaveBeenCalledTimes(2);

    result.cleanup();

    expect(clearTimeout).toHaveBeenCalledWith(7);
    expect(outputVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it('bypasses resizing when the reported source size already fits the target', async () => {
    const sourceStream = makeStream([
      makeTrack('video', { width: 640, height: 360, frameRate: 30 }),
    ]);
    const createElement = jest.fn();

    const result = await createResizedVideoStream(sourceStream, {
      width: 1280,
      height: 720,
      frameRate: 30,
    }, {
      document: {
        createElement: createElement as any,
      },
    });

    expect(result.resized).toBe(false);
    expect(result.stream).toBe(sourceStream);
    expect(createElement).not.toHaveBeenCalled();
  });

  it('skips unnecessary upscaling when metadata reveals an already-small source', async () => {
    const sourceStream = makeStream([
      makeTrack('video'),
    ]);
    const video = {
      srcObject: null,
      muted: false,
      playsInline: false,
      autoplay: false,
      hidden: false,
      style: {},
      videoWidth: 640,
      videoHeight: 360,
      play: jest.fn().mockResolvedValue(undefined),
      pause: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as any;

    const result = await createResizedVideoStream(sourceStream, {
      width: 1280,
      height: 720,
      frameRate: 30,
    }, {
      document: {
        createElement: jest.fn(() => video),
      },
    });

    expect(result.resized).toBe(false);
    expect(result.stream).toBe(sourceStream);
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
  });

  it('keeps the canvas transform when only frame rate must be reduced', async () => {
    const sourceAudioTrack = makeTrack('audio');
    const sourceVideoTrack = makeTrack('video', { width: 1920, height: 1080, frameRate: 30 });
    const sourceStream = makeStream([sourceAudioTrack, sourceVideoTrack]);
    const outputVideoTrack = makeTrack('video', { width: 1920, height: 1080, frameRate: 24 });
    const captureStream = makeStream([outputVideoTrack]);
    const video = {
      srcObject: null,
      muted: false,
      playsInline: false,
      autoplay: false,
      hidden: false,
      style: {},
      videoWidth: 1920,
      videoHeight: 1080,
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
        drawImage: jest.fn(),
        imageSmoothingEnabled: false,
        imageSmoothingQuality: 'low',
      })),
      captureStream: jest.fn(() => captureStream),
    } as any;

    const result = await createResizedVideoStream(sourceStream, {
      width: 1920,
      height: 1080,
      frameRate: 24,
    }, {
      document: {
        createElement: jest.fn((tagName: 'video' | 'canvas') => (tagName === 'video' ? video : canvas)),
      },
      createMediaStream: jest.fn((tracks: MediaStreamTrack[]) => makeStream(tracks as any[])),
      setTimeout: jest.fn(() => 1 as any) as any,
      clearTimeout: jest.fn() as any,
    });

    expect(result.resized).toBe(true);
    expect(result.output).toEqual({
      width: 1920,
      height: 1080,
      frameRate: 24,
    });
    expect(canvas.captureStream).toHaveBeenCalledWith(24);
    result.cleanup();
  });
});
