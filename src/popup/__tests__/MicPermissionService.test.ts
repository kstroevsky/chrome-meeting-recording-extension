import { MicPermissionService } from '../MicPermissionService';
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

/** Drains the async click/refresh chains (multiple awaited promises). */
async function flush() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MicPermissionService', () => {
  let service: MicPermissionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MicPermissionService();
    jest.spyOn(window, 'alert').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('queryMicPermissionState', () => {
    it('returns "unknown" when the Permissions API is unavailable', async () => {
      setPermissionState('missing');
      expect(await service.queryMicPermissionState()).toBe('unknown');
    });

    it('returns "unknown" when the query throws', async () => {
      setPermissionState('throw');
      expect(await service.queryMicPermissionState()).toBe('unknown');
    });

    it('returns the reported permission state', async () => {
      setPermissionState('granted');
      expect(await service.queryMicPermissionState()).toBe('granted');
    });
  });

  describe('ensureReadyForRecording', () => {
    it('short-circuits to ready when mic mode is off (no permission query)', async () => {
      setPermissionState('denied');
      expect(await service.ensureReadyForRecording('off')).toBe(true);
      expect(createRuntimeTab).not.toHaveBeenCalled();
    });

    it('is ready immediately when permission is already granted', async () => {
      setPermissionState('granted');
      expect(await service.ensureReadyForRecording('mixed')).toBe(true);
      expect(createRuntimeTab).not.toHaveBeenCalled();
    });

    it('opens the mic setup tab and fails when permission is denied', async () => {
      setPermissionState('denied');
      expect(await service.ensureReadyForRecording('separate')).toBe(false);
      expect(createRuntimeTab).toHaveBeenCalledWith('micsetup.html');
    });

    it('primes inline and becomes ready when the prompt is grantable', async () => {
      setPermissionState('prompt');
      const { stop } = mockGetUserMedia('grant');
      expect(await service.ensureReadyForRecording('mixed')).toBe(true);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(createRuntimeTab).not.toHaveBeenCalled();
    });

    it('falls back to the setup tab when inline priming is rejected', async () => {
      setPermissionState('prompt');
      mockGetUserMedia('reject');
      expect(await service.ensureReadyForRecording('separate')).toBe(false);
      expect(createRuntimeTab).toHaveBeenCalledWith('micsetup.html');
    });
  });

  describe('bindButton', () => {
    function makeButton() {
      return document.createElement('button');
    }

    it('renders the granted state as a disabled, enabled-label button', async () => {
      setPermissionState('granted');
      const btn = makeButton();
      const onText = jest.fn();
      service.bindButton(btn, onText);
      await Promise.resolve();
      await Promise.resolve();

      expect(btn.textContent).toBe('Microphone Enabled ✓');
      expect(btn.disabled).toBe(true);
      expect(onText).toHaveBeenCalledWith('Microphone Enabled ✓');
    });

    it('renders the blocked label when permission is denied', async () => {
      setPermissionState('denied');
      const btn = makeButton();
      service.bindButton(btn);
      await Promise.resolve();
      await Promise.resolve();

      expect(btn.textContent).toBe('Microphone Blocked');
      expect(btn.disabled).toBe(false);
    });

    it('alerts without opening a setup tab when clicked while already granted', async () => {
      setPermissionState('granted');
      const btn = makeButton();
      service.bindButton(btn);
      await Promise.resolve();

      btn.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(window.alert).toHaveBeenCalledWith('Microphone is already enabled for this extension.');
      expect(createRuntimeTab).not.toHaveBeenCalled();
    });

    it('opens the setup tab when clicked while denied', async () => {
      setPermissionState('denied');
      const btn = makeButton();
      service.bindButton(btn);
      await Promise.resolve();

      btn.click();
      await Promise.resolve();
      await Promise.resolve();

      expect(createRuntimeTab).toHaveBeenCalledWith('micsetup.html');
    });

    it('reports a friendly error when opening the setup tab throws', async () => {
      setPermissionState('denied');
      (createRuntimeTab as jest.Mock).mockRejectedValueOnce(new Error('no tabs permission'));
      const btn = makeButton();
      service.bindButton(btn);
      await flush();

      btn.click();
      await flush();

      expect(console.error).toHaveBeenCalledWith('[popup] mic enable flow error', expect.any(Error));
      expect(window.alert).toHaveBeenCalledWith('Could not open the microphone setup page. Please try again.');
    });

    it('primes inline and alerts success when clicked from the prompt state', async () => {
      setPermissionState('prompt');
      mockGetUserMedia('grant');
      const btn = makeButton();
      service.bindButton(btn);
      await flush();

      btn.click();
      await flush();

      expect(window.alert).toHaveBeenCalledWith('Microphone enabled for the extension.');
    });
  });
});
