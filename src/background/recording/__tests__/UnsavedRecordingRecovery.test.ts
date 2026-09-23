import { UnsavedRecordingRecovery } from '../UnsavedRecordingRecovery';
import { markCaptureSettled } from '../unsavedCaptureFlag';

jest.mock('../../../shared/settings', () => ({
  loadExtensionSettingsFromStorage: jest.fn().mockResolvedValue({
    basic: { recordingMode: 'local' },
  }),
  toStorageMode: () => 'local',
}));
jest.mock('../unsavedCaptureFlag', () => ({
  captureMayBeUnsaved: jest.fn().mockResolvedValue(true),
  markCaptureSettled: jest.fn().mockResolvedValue(undefined),
  recordedCaptureDurationMs: jest.fn().mockResolvedValue(undefined),
}));

describe('UnsavedRecordingRecovery', () => {
  const session = { getSnapshot: () => ({ phase: 'idle' }) } as never;
  const logger = { warn: jest.fn() };

  beforeEach(() => jest.clearAllMocks());

  it('keeps the global unsaved marker while another orphan remains', async () => {
    const offscreen = {
      ensureReady: jest.fn().mockResolvedValue(undefined),
      rpc: jest.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({
          ok: true,
          recordings: [{ key: 'staging/other', lastModifiedMs: 1, bytes: 10 }],
        }),
    };
    const recovery = new UnsavedRecordingRecovery(offscreen as never, session, logger);

    await recovery.resolve('staging/one', 'discard');

    expect(markCaptureSettled).not.toHaveBeenCalled();
  });

  it('clears the global unsaved marker only after the last orphan is gone', async () => {
    const offscreen = {
      ensureReady: jest.fn().mockResolvedValue(undefined),
      rpc: jest.fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true, recordings: [] }),
    };
    const recovery = new UnsavedRecordingRecovery(offscreen as never, session, logger);

    await recovery.resolve('staging/last', 'save', 'Recovered');

    expect(markCaptureSettled).toHaveBeenCalledTimes(1);
  });
});
