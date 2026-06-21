import {
  buildDefaultRunConfigFromSettings,
  buildRecorderRuntimeSettingsSnapshot,
  DEFAULT_EXTENSION_SETTINGS,
  getSelfVideoProfileSettings,
  getTabOutputSettings,
  normalizeRecorderRuntimeSettingsSnapshot,
  normalizeExtensionSettings,
  resolveTabVideoBitrate,
  TAB_SCREEN_QUALITY_FACTOR,
  TAB_VIDEO_QUALITY_FACTOR,
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

  it('passes the tab content type through to tab output settings', () => {
    // There is no user-facing bitrate knob; the offscreen derives the bitrate from
    // this content type's factor and the delivered dimensions, capped at the
    // internal MAX_TAB_VIDEO_BITRATE ceiling.
    expect(getTabOutputSettings(DEFAULT_EXTENSION_SETTINGS).contentType).toBe('screen');
    const settings = normalizeExtensionSettings({ professional: { tabContentType: 'video' } });
    expect(getTabOutputSettings(settings).contentType).toBe('video');
  });

  it('resolveTabVideoBitrate scales with a quality factor and clamps to floor/ceiling', () => {
    // Screen factor at 1080p30: ~1.49 Mbps — matches historical target.
    expect(resolveTabVideoBitrate(1920, 1080, 30, TAB_SCREEN_QUALITY_FACTOR)).toBe(
      Math.round(1920 * 1080 * 30 * TAB_SCREEN_QUALITY_FACTOR)
    );
    // 360p30 with screen factor falls below the 250 kbps floor → clamped.
    expect(resolveTabVideoBitrate(640, 360, 30, TAB_SCREEN_QUALITY_FACTOR)).toBe(250_000);
    // Video factor at 1080p30: ~4.97 Mbps.
    expect(resolveTabVideoBitrate(1920, 1080, 30, TAB_VIDEO_QUALITY_FACTOR)).toBe(
      Math.round(1920 * 1080 * 30 * TAB_VIDEO_QUALITY_FACTOR)
    );
    // Ceiling parameter clamps when the estimate exceeds it.
    expect(resolveTabVideoBitrate(1920, 1080, 30, TAB_VIDEO_QUALITY_FACTOR, 3_000_000)).toBe(3_000_000);
  });

  it('defaults tabContentType to screen and normalizes video correctly', () => {
    expect(normalizeExtensionSettings({}).professional.tabContentType).toBe('screen');
    const video = normalizeExtensionSettings({ professional: { tabContentType: 'video' } });
    expect(video.professional.tabContentType).toBe('video');
    const invalid = normalizeExtensionSettings({ professional: { tabContentType: 'animation' } });
    expect(invalid.professional.tabContentType).toBe('screen');
  });

  it('carries the persisted tab content type into the popup default run config', () => {
    // The popup pre-selects this default, then may override it per-recording.
    expect(buildDefaultRunConfigFromSettings(DEFAULT_EXTENSION_SETTINGS).tabContentType).toBe('screen');
    const video = normalizeExtensionSettings({ professional: { tabContentType: 'video' } });
    expect(buildDefaultRunConfigFromSettings(video).tabContentType).toBe('video');
  });

  it('drops a legacy persisted tabVideoBitrate (the ceiling is now internal-only)', () => {
    const settings = normalizeExtensionSettings({ professional: { tabVideoBitrate: 1_500_000 } });
    expect((settings.professional as Record<string, unknown>).tabVideoBitrate).toBeUndefined();
  });

  it('drops legacy persisted self-video bitrate settings (the envelope is now internal-only)', () => {
    const settings = normalizeExtensionSettings({
      professional: {
        selfVideoBitrate: 6_000_000,
        selfVideoMinAdaptiveBitrate: 6_000_000,
      },
    });

    expect((settings.professional as Record<string, unknown>).selfVideoBitrate).toBeUndefined();
    expect((settings.professional as Record<string, unknown>).selfVideoMinAdaptiveBitrate).toBeUndefined();
  });

  it('builds a recorder runtime snapshot from the normalized capture settings', () => {
    const settings = normalizeExtensionSettings({
      basic: {
        selfVideoResolutionPreset: '1280x720',
      },
      professional: {
        selfVideoFrameRate: 24,
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
        output: { maxWidth: 640, maxHeight: 360, maxFrameRate: 20, contentType: 'screen' },
      },
      selfVideo: {
        profile: {
          width: 1280,
          height: 720,
          frameRate: 24,
          aspectRatio: 1280 / 720,
          // Camera bitrate envelope is now internal (constants), not user-set.
          defaultBitsPerSecond: 3_000_000,
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
