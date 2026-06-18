import {
  buildRecorderRuntimeSettingsSnapshot,
  DEFAULT_EXTENSION_SETTINGS,
  getSelfVideoProfileSettings,
  getTabOutputSettings,
  normalizeRecorderRuntimeSettingsSnapshot,
  normalizeExtensionSettings,
  resolveTabVideoBitrate,
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

  it('passes the reference bitrate through to tab output settings unchanged', () => {
    // getTabOutputSettings no longer pre-scales; it hands the reference off to
    // the offscreen, which scales against the delivered track dimensions instead.
    expect(getTabOutputSettings(DEFAULT_EXTENSION_SETTINGS).referenceBitsPerSecond).toBe(
      DEFAULT_EXTENSION_SETTINGS.professional.tabVideoBitrate
    );
    const settings = normalizeExtensionSettings({ professional: { tabVideoBitrate: 3_000_000 } });
    expect(getTabOutputSettings(settings).referenceBitsPerSecond).toBe(3_000_000);
  });

  it('resolveTabVideoBitrate scales with delivered resolution and clamps to floor/ceiling', () => {
    const ref = 1_500_000;
    // 1080p30 is the reference — ratio = 1, output equals input.
    expect(resolveTabVideoBitrate(1920, 1080, 30, ref)).toBe(1_500_000);
    // 720p30 scales down by the pixels-per-second ratio.
    expect(resolveTabVideoBitrate(1280, 720, 30, ref)).toBe(
      Math.round(ref * (1280 * 720 * 30) / (1920 * 1080 * 30))
    );
    // 360p30 falls below the 250 kbps floor and is clamped.
    expect(resolveTabVideoBitrate(640, 360, 30, ref)).toBe(250_000);
    // High reference at 1080p60 would exceed the 8 Mbps ceiling and is clamped.
    expect(resolveTabVideoBitrate(1920, 1080, 60, 8_000_000)).toBe(8_000_000);
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
        // Reference bitrate is passed through unscaled; the offscreen scales it against
        // the delivered track dims after getUserMedia.
        output: { maxWidth: 640, maxHeight: 360, maxFrameRate: 20, referenceBitsPerSecond: 1_500_000 },
      },
      selfVideo: {
        profile: {
          width: 1280,
          height: 720,
          frameRate: 24,
          aspectRatio: 1280 / 720,
          defaultBitsPerSecond: 2_000_000,
          minAdaptiveBitsPerSecond: 1_000_000,
          autoResolution: true,
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

  it('defaults selfVideoUseAutoResolution on and carries it into the snapshot profile', () => {
    expect(normalizeExtensionSettings({}).basic.selfVideoUseAutoResolution).toBe(true);

    const off = normalizeExtensionSettings({ basic: { selfVideoUseAutoResolution: false } });
    expect(off.basic.selfVideoUseAutoResolution).toBe(false);
    expect(buildRecorderRuntimeSettingsSnapshot(off).selfVideo.profile.autoResolution).toBe(false);
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
