import { RecorderEngine } from '../src/offscreen/RecorderEngine';

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

describe('RecorderEngine', () => {
  let deps: any;
  let engine: RecorderEngine;

  beforeEach(() => {
    deps = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      notifyPhase: jest.fn(),
      enableMicMix: false,
    };
    engine = new RecorderEngine(deps);
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
});
