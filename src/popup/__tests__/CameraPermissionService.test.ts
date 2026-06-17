import { CameraPermissionService } from '../CameraPermissionService';
import { createRuntimeTab } from '../../platform/chrome/tabs';

jest.mock('../../platform/chrome/tabs', () => ({
  createRuntimeTab: jest.fn().mockResolvedValue(undefined),
}));

type PermState = 'granted' | 'denied' | 'prompt';

function setPermissionState(state: PermState | 'throw' | 'missing') {
  if (state === 'missing') {
    Object.defineProperty(global.navigator, 'permissions', { value: undefined, configurable: true });
    return;
  }
  Object.defineProperty(global.navigator, 'permissions', {
    value: {
      query: jest.fn(async () => {
        if (state === 'throw') throw new Error('query unsupported');
        return { state };
      }),
    },
    configurable: true,
  });
}

function mockGetUserMedia(result: 'grant' | 'reject') {
  const stop = jest.fn();
  (navigator.mediaDevices.getUserMedia as jest.Mock).mockImplementation(async () => {
    if (result === 'reject') throw new Error('NotAllowedError');
    return { getTracks: () => [{ stop }] };
  });
  return { stop };
}

describe('CameraPermissionService', () => {
  let service: CameraPermissionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CameraPermissionService();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('queryCameraPermissionState', () => {
    it('returns "unknown" without a Permissions API', async () => {
      setPermissionState('missing');
      expect(await service.queryCameraPermissionState()).toBe('unknown');
    });

    it('returns "unknown" when the query throws', async () => {
      setPermissionState('throw');
      expect(await service.queryCameraPermissionState()).toBe('unknown');
    });

    it('returns the reported state', async () => {
      setPermissionState('prompt');
      expect(await service.queryCameraPermissionState()).toBe('prompt');
    });
  });

  describe('ensureReadyForRecording', () => {
    it('is ready immediately when camera permission is granted', async () => {
      setPermissionState('granted');
      expect(await service.ensureReadyForRecording()).toBe(true);
      expect(createRuntimeTab).not.toHaveBeenCalled();
    });

    it('opens the camera setup tab and fails when denied', async () => {
      setPermissionState('denied');
      expect(await service.ensureReadyForRecording()).toBe(false);
      expect(createRuntimeTab).toHaveBeenCalledWith('camsetup.html');
    });

    it('primes inline and becomes ready from the prompt state', async () => {
      setPermissionState('prompt');
      const { stop } = mockGetUserMedia('grant');
      expect(await service.ensureReadyForRecording()).toBe(true);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(createRuntimeTab).not.toHaveBeenCalled();
    });

    it('falls back to the setup tab when inline priming fails', async () => {
      setPermissionState('prompt');
      mockGetUserMedia('reject');
      expect(await service.ensureReadyForRecording()).toBe(false);
      expect(createRuntimeTab).toHaveBeenCalledWith('camsetup.html');
    });
  });
});
