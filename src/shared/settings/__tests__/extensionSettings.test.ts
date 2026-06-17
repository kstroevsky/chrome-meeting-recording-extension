import {
  buildRecorderRuntimeSettingsSnapshot,
  DEFAULT_EXTENSION_SETTINGS,
  getSelfVideoProfileSettings,
  getTabOutputSettings,
  normalizeRecorderRuntimeSettingsSnapshot,
  normalizeExtensionSettings,
} from '..';

describe('settings', () => {
  it('uses preset-based defaults for camera and tab resolution', () => {
    expect(DEFAULT_EXTENSION_SETTINGS.basic.selfVideoResolutionPreset).toBe('1920x1080');
    expect(DEFAULT_EXTENSION_SETTINGS.professional.tabResolutionPreset).toBe('1920x1080');
    expect(getSelfVideoProfileSettings(DEFAULT_EXTENSION_SETTINGS)).toEqual(
      expect.objectContaining({
        width: 1920,
        height: 1080,
      })
    );
    expect(getTabOutputSettings(DEFAULT_EXTENSION_SETTINGS)).toEqual(
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
    expect(getTabOutputSettings(settings)).toEqual(
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

  it('scales the tab video bitrate with the selected resolution preset', () => {
    // Default 1080p30 keeps the historical 1.5 Mbps bitrate exactly.
    expect(getTabOutputSettings(DEFAULT_EXTENSION_SETTINGS).videoBitsPerSecond).toBe(1_500_000);

    // 720p30 scales the reference bitrate down by the pixels-per-second ratio.
    const at720p = normalizeExtensionSettings({ professional: { tabResolutionPreset: '1280x720' } });
    expect(getTabOutputSettings(at720p).videoBitsPerSecond).toBe(
      Math.round(1_500_000 * (1280 * 720 * 30) / (1920 * 1080 * 30))
    );

    // The smallest preset clamps to the bitrate floor instead of going arbitrarily low.
    const at360p = normalizeExtensionSettings({ professional: { tabResolutionPreset: '640x360' } });
    expect(getTabOutputSettings(at360p).videoBitsPerSecond).toBe(250_000);
  });

  it('honors a custom tab video bitrate while still scaling with resolution', () => {
    const settings = normalizeExtensionSettings({
      professional: { tabResolutionPreset: '1280x720', tabVideoBitrate: 3_000_000 },
    });
    expect(settings.professional.tabVideoBitrate).toBe(3_000_000);
    expect(getTabOutputSettings(settings).videoBitsPerSecond).toBe(
      Math.round(3_000_000 * (1280 * 720 * 30) / (1920 * 1080 * 30))
    );
  });

  it('honors an in-range tab video bitrate but rejects values past the 8 Mbps ceiling', () => {
    const inRange = normalizeExtensionSettings({ professional: { tabVideoBitrate: 4_000_000 } });
    expect(inRange.professional.tabVideoBitrate).toBe(4_000_000);

    const tooHigh = normalizeExtensionSettings({ professional: { tabVideoBitrate: 50_000_000 } });
    expect(tooHigh.professional.tabVideoBitrate).toBe(
      DEFAULT_EXTENSION_SETTINGS.professional.tabVideoBitrate
    );
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

  it('builds a recorder runtime snapshot from the normalized capture settings', () => {
    const settings = normalizeExtensionSettings({
      basic: {
        selfVideoResolutionPreset: '1280x720',
      },
      professional: {
        selfVideoFrameRate: 24,
        selfVideoBitrate: 2_000_000,
        selfVideoMinAdaptiveBitrate: 1_000_000,
        tabResolutionPreset: '640x360',
        tabMaxFrameRate: 20,
        microphoneEchoCancellation: false,
        microphoneNoiseSuppression: true,
        microphoneAutoGainControl: false,
        chunkDefaultTimesliceMs: 1500,
        chunkExtendedTimesliceMs: 4500,
      },
    });

    expect(buildRecorderRuntimeSettingsSnapshot(settings)).toEqual({
      tab: {
        // 640x360@20 scales the 1080p reference bitrate below the floor → clamped.
        output: { maxWidth: 640, maxHeight: 360, maxFrameRate: 20, videoBitsPerSecond: 250_000 },
      },
      selfVideo: {
        profile: {
          width: 1280,
          height: 720,
          frameRate: 24,
          aspectRatio: 1280 / 720,
          defaultBitsPerSecond: 2_000_000,
          minAdaptiveBitsPerSecond: 1_000_000,
          autoResolution: false,
        },
      },
      microphone: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
      },
      chunking: {
        defaultTimesliceMs: 1500,
        extendedTimesliceMs: 4500,
      },
    });
  });

  it('defaults selfVideoUseAutoResolution off and carries it into the snapshot profile', () => {
    expect(normalizeExtensionSettings({}).basic.selfVideoUseAutoResolution).toBe(false);

    const on = normalizeExtensionSettings({ basic: { selfVideoUseAutoResolution: true } });
    expect(on.basic.selfVideoUseAutoResolution).toBe(true);
    expect(buildRecorderRuntimeSettingsSnapshot(on).selfVideo.profile.autoResolution).toBe(true);
  });

  it('defaults a snapshot profile missing autoResolution to false on validation', () => {
    const snapshot = buildRecorderRuntimeSettingsSnapshot(normalizeExtensionSettings({}));
    const legacy = { ...snapshot, selfVideo: { profile: { ...snapshot.selfVideo.profile } } };
    delete (legacy.selfVideo.profile as any).autoResolution;

    expect(normalizeRecorderRuntimeSettingsSnapshot(legacy)?.selfVideo.profile.autoResolution).toBe(false);
  });

  it('accepts only valid recorder runtime snapshots without applying silent defaults', () => {
    const snapshot = buildRecorderRuntimeSettingsSnapshot(
      normalizeExtensionSettings({
        professional: {
          tabResolutionPreset: '640x360',
        },
      })
    );

    expect(normalizeRecorderRuntimeSettingsSnapshot(snapshot)).toEqual(snapshot);
    expect(
      normalizeRecorderRuntimeSettingsSnapshot({
        ...snapshot,
        tab: {
          output: {
            ...snapshot.tab.output,
            maxFrameRate: 'fast',
          },
        },
      })
    ).toBeNull();
  });
});
