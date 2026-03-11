import {
  DEFAULT_EXTENSION_SETTINGS,
  getSelfVideoProfileSettings,
  getTabCaptureSettings,
  normalizeExtensionSettings,
} from '../src/shared/extensionSettings';

describe('extensionSettings', () => {
  it('uses preset-based defaults for camera and tab resolution', () => {
    expect(DEFAULT_EXTENSION_SETTINGS.basic.selfVideoResolutionPreset).toBe('1920x1080');
    expect(DEFAULT_EXTENSION_SETTINGS.professional.tabResolutionPreset).toBe('1920x1080');
    expect(getSelfVideoProfileSettings(DEFAULT_EXTENSION_SETTINGS)).toEqual(
      expect.objectContaining({
        width: 1920,
        height: 1080,
      })
    );
    expect(getTabCaptureSettings(DEFAULT_EXTENSION_SETTINGS)).toEqual(
      expect.objectContaining({
        maxWidth: 1920,
        maxHeight: 1080,
      })
    );
  });

  it('accepts the new preset fields directly', () => {
    const settings = normalizeExtensionSettings({
      basic: {
        selfVideoResolutionPreset: '1280x720',
      },
      professional: {
        tabResolutionPreset: '854x480',
      },
    });

    expect(settings.basic.selfVideoResolutionPreset).toBe('1280x720');
    expect(settings.professional.tabResolutionPreset).toBe('854x480');
    expect(getSelfVideoProfileSettings(settings)).toEqual(
      expect.objectContaining({
        width: 1280,
        height: 720,
      })
    );
    expect(getTabCaptureSettings(settings)).toEqual(
      expect.objectContaining({
        maxWidth: 854,
        maxHeight: 480,
      })
    );
  });

  it('migrates legacy camera width and height formats to the matching preset', () => {
    const settings = normalizeExtensionSettings({
      basic: {
        selfVideoWidthFormat: 720,
        selfVideoHeightFormat: 720,
      },
    });

    expect(settings.basic.selfVideoResolutionPreset).toBe('1280x720');
  });

  it('falls back to the legacy camera width format preset when the old pair was not exact', () => {
    const settings = normalizeExtensionSettings({
      basic: {
        selfVideoWidthFormat: 480,
        selfVideoHeightFormat: 360,
      },
    });

    expect(settings.basic.selfVideoResolutionPreset).toBe('854x480');
  });

  it('migrates legacy tab max size to the nearest supported preset within bounds', () => {
    const settings = normalizeExtensionSettings({
      professional: {
        tabMaxWidth: 1600,
        tabMaxHeight: 900,
      },
    });

    expect(settings.professional.tabResolutionPreset).toBe('1280x720');
  });

  it('defaults legacy tab sizes smaller than every preset back to 1080p', () => {
    const settings = normalizeExtensionSettings({
      professional: {
        tabMaxWidth: 500,
        tabMaxHeight: 300,
      },
    });

    expect(settings.professional.tabResolutionPreset).toBe('1920x1080');
  });

  it('caps persisted self-video bitrate settings at the new 3 Mbps ceiling', () => {
    const settings = normalizeExtensionSettings({
      professional: {
        selfVideoBitrate: 6_000_000,
        selfVideoMinAdaptiveBitrate: 6_000_000,
      },
    });

    expect(settings.professional.selfVideoBitrate).toBe(3_000_000);
    expect(settings.professional.selfVideoMinAdaptiveBitrate).toBe(3_000_000);
  });
});
