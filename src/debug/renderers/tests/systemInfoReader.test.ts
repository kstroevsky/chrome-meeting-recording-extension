jest.mock('../../../shared/build', () => ({
  isTestRuntime: jest.fn(() => true),
}));

import {
  buildSystemInfoText,
  readWebGlInfo,
  readWebGpuInfo,
} from '../SystemInfoReader';
import { isTestRuntime } from '../../../shared/build';

function setGpu(value: unknown) {
  Object.defineProperty(global.navigator, 'gpu', { value, configurable: true });
}

describe('SystemInfoReader', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    (isTestRuntime as jest.Mock).mockReturnValue(true);
    setGpu(undefined);
  });

  describe('readWebGlInfo', () => {
    it('returns nulls in the test runtime (guarded)', () => {
      (isTestRuntime as jest.Mock).mockReturnValue(true);
      expect(readWebGlInfo()).toEqual({ vendor: null, renderer: null });
    });

    it('reads vendor and renderer via the WebGL debug extension', () => {
      (isTestRuntime as jest.Mock).mockReturnValue(false);
      const fakeGl = {
        getExtension: (name: string) =>
          name === 'WEBGL_debug_renderer_info'
            ? { UNMASKED_VENDOR_WEBGL: 1, UNMASKED_RENDERER_WEBGL: 2 }
            : null,
        getParameter: (p: number) => (p === 1 ? 'Acme Inc' : p === 2 ? 'Acme GPU 3000' : ''),
        RENDERER: 7,
      };
      jest.spyOn(document, 'createElement').mockReturnValue({ getContext: () => fakeGl } as any);

      expect(readWebGlInfo()).toEqual({ vendor: 'Acme Inc', renderer: 'Acme GPU 3000' });
    });

    it('returns nulls when no WebGL context is available', () => {
      (isTestRuntime as jest.Mock).mockReturnValue(false);
      jest.spyOn(document, 'createElement').mockReturnValue({ getContext: () => null } as any);
      expect(readWebGlInfo()).toEqual({ vendor: null, renderer: null });
    });
  });

  describe('readWebGpuInfo', () => {
    it('returns null when WebGPU is unavailable', async () => {
      setGpu(undefined);
      expect(await readWebGpuInfo()).toBeNull();
    });

    it('returns null when no adapter is granted', async () => {
      setGpu({ requestAdapter: jest.fn().mockResolvedValue(null) });
      expect(await readWebGpuInfo()).toBeNull();
    });

    it('joins adapter info fields when present', async () => {
      setGpu({
        requestAdapter: jest.fn().mockResolvedValue({
          requestAdapterInfo: jest.fn().mockResolvedValue({
            vendor: 'nvidia',
            architecture: 'ampere',
            device: 'rtx',
            description: 'card',
          }),
        }),
      });
      expect(await readWebGpuInfo()).toBe('nvidia / ampere / rtx / card');
    });

    it('falls back to the adapter name when info is unavailable', async () => {
      setGpu({
        requestAdapter: jest.fn().mockResolvedValue({
          requestAdapterInfo: jest.fn().mockResolvedValue(null),
          name: 'Fallback Adapter',
        }),
      });
      expect(await readWebGpuInfo()).toBe('Fallback Adapter');
    });
  });

  describe('buildSystemInfoText', () => {
    it('assembles the capability disclaimer and hardware lines', async () => {
      setGpu(undefined);
      const text = await buildSystemInfoText();

      expect(text).toContain('True system CPU/GPU utilization is not exposed by Chrome extension APIs.');
      expect(text).toContain('Hardware threads:');
      expect(text).toContain('WebGL vendor: n/a');
      expect(text).toContain('WebGPU adapter: unavailable');
    });
  });
});
