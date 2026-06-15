import { OffscreenController } from '../src/offscreen/OffscreenController';

function makeController(now = 1000) {
  const postMessage = jest.fn();
  const sampler = { markActivePhaseStart: jest.fn() };
  const error = jest.fn();
  const controller = new OffscreenController({ postMessage, sampler, error, now: () => now });
  return { controller, postMessage, sampler, error };
}

const artifact = (stream: string) => ({ stream, artifact: { file: new Blob(['x']) } }) as any;

function lastState(postMessage: jest.Mock) {
  return postMessage.mock.calls[postMessage.mock.calls.length - 1][0];
}

describe('OffscreenController', () => {
  describe('pushState', () => {
    it('broadcasts the phase without warnings by default', () => {
      const { controller, postMessage } = makeController();
      controller.pushState('recording');
      expect(postMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_STATE', phase: 'recording', epoch: 0 });
      expect(controller.currentPhase()).toBe('recording');
    });

    it('includes accumulated warnings and merged extra fields', () => {
      const { controller, postMessage } = makeController();
      controller.reportWarning('low disk');
      controller.pushState('uploading', { uploadSummary: { uploaded: [], localFallbacks: [] } });

      expect(lastState(postMessage)).toEqual({
        type: 'OFFSCREEN_STATE',
        phase: 'uploading',
        epoch: 0,
        warnings: ['low disk'],
        uploadSummary: { uploaded: [], localFallbacks: [] },
      });
    });

    it('rebaselines the sampler only when entering a new active phase', () => {
      const { controller, sampler } = makeController(4242);
      controller.pushState('recording');
      expect(sampler.markActivePhaseStart).toHaveBeenCalledWith(4242);

      controller.pushState('recording'); // unchanged phase → no rebaseline
      controller.pushState('idle'); // idle never rebaselines
      expect(sampler.markActivePhaseStart).toHaveBeenCalledTimes(1);
    });
  });

  describe('reportWarning', () => {
    it('trims, de-duplicates, and ignores empty warnings', () => {
      const { controller, postMessage } = makeController();
      controller.pushState('recording');
      postMessage.mockClear();

      controller.reportWarning('  hot mic  ');
      controller.reportWarning('hot mic'); // duplicate
      controller.reportWarning('   '); // empty

      expect(controller.currentWarnings()).toEqual(['hot mic']);
      expect(postMessage).toHaveBeenCalledTimes(1); // only the first, novel warning re-pushes
    });

    it('clearWarnings empties the accumulated list', () => {
      const { controller } = makeController();
      controller.reportWarning('a');
      controller.clearWarnings();
      expect(controller.currentWarnings()).toEqual([]);
    });
  });

  describe('finalize', () => {
    function attach(controller: OffscreenController, opts: {
      artifacts?: any[];
      summary?: any;
      stopError?: Error;
    } = {}) {
      const stop = jest.fn().mockImplementation(() =>
        opts.stopError ? Promise.reject(opts.stopError) : Promise.resolve(opts.artifacts ?? [artifact('tab')])
      );
      const finalize = jest.fn().mockResolvedValue(opts.summary);
      controller.attachServices({ stop } as any, { finalize } as any);
      return { stop, finalize };
    }

    it('throws if services were never attached', () => {
      const { controller } = makeController();
      expect(() => controller.finalize()).toThrow('attachServices must be called');
    });

    it('saves locally without an uploading phase and returns to idle', async () => {
      const { controller, postMessage } = makeController();
      const { stop, finalize } = attach(controller, { artifacts: [artifact('tab')] });
      controller.onStartRequested({ storageMode: 'local', micMode: 'off', recordSelfVideo: false }, 'local', 7);

      await controller.finalize();

      expect(stop).toHaveBeenCalledTimes(1);
      expect(finalize).toHaveBeenCalledWith({ artifacts: [expect.objectContaining({ stream: 'tab' })], storageMode: 'local' });
      const phases = postMessage.mock.calls.map((c) => c[0].phase);
      expect(phases).not.toContain('uploading');
      expect(controller.currentPhase()).toBe('idle');
    });

    it('signals uploading for Drive runs with artifacts and carries the summary to idle', async () => {
      const { controller, postMessage } = makeController();
      const summary = { uploaded: [{ stream: 'tab', filename: 'tab.webm' }], localFallbacks: [] };
      attach(controller, { artifacts: [artifact('tab')], summary });
      controller.onStartRequested({ storageMode: 'drive', micMode: 'off', recordSelfVideo: false }, 'drive', 7);

      await controller.finalize();

      const phases = postMessage.mock.calls.map((c) => c[0].phase);
      expect(phases).toEqual(['uploading', 'idle']);
      expect(lastState(postMessage)).toEqual({ type: 'OFFSCREEN_STATE', phase: 'idle', epoch: 7, uploadSummary: summary });
    });

    it('does not signal uploading for a Drive run that produced no artifacts', async () => {
      const { controller, postMessage } = makeController();
      attach(controller, { artifacts: [] });
      controller.onStartRequested({ storageMode: 'drive', micMode: 'off', recordSelfVideo: false }, 'drive', 7);

      await controller.finalize();

      const phases = postMessage.mock.calls.map((c) => c[0].phase);
      expect(phases).toEqual(['idle']);
    });

    it('shares one in-flight run across concurrent finalize calls', async () => {
      const { controller } = makeController();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const stop = jest.fn().mockImplementation(async () => { await gate; return []; });
      const finalize = jest.fn().mockResolvedValue(undefined);
      controller.attachServices({ stop } as any, { finalize } as any);

      const a = controller.finalize();
      const b = controller.finalize();
      expect(a).toBe(b);
      expect(controller.isFinalizing()).toBe(true);

      release();
      await a;

      expect(stop).toHaveBeenCalledTimes(1);
      expect(controller.isFinalizing()).toBe(false);
    });

    it('reports a failed phase when the pipeline throws and clears the in-flight flag', async () => {
      const { controller, postMessage, error } = makeController();
      attach(controller, { stopError: new Error('capture lost') });

      await controller.finalize();

      expect(error).toHaveBeenCalledWith('Stop/finalize pipeline failed', 'Error: capture lost');
      expect(lastState(postMessage)).toEqual({ type: 'OFFSCREEN_STATE', phase: 'failed', epoch: 0, error: 'Error: capture lost' });
      expect(controller.isFinalizing()).toBe(false);
    });

    it('onStopRequested triggers a finalize run', async () => {
      const { controller } = makeController();
      const { stop } = attach(controller);
      controller.onStopRequested();
      await Promise.resolve();
      await Promise.resolve();
      expect(stop).toHaveBeenCalledTimes(1);
    });
  });
});
