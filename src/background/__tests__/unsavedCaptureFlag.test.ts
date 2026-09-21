/**
 * The bit that decides whether the popup goes looking, and the run's own clock
 * that says how long it had recorded (8D). It lives in `storage.local` because
 * the crash worth surviving takes the browser — and `storage.session` — with it.
 */
import {
  captureMayBeUnsaved,
  markCaptureSettled,
  markCaptureStarted,
  noteCaptureProgress,
  recordedCaptureDurationMs,
} from '../recording/unsavedCaptureFlag';

const local = () => chrome.storage.local as unknown as {
  get: jest.Mock; set: jest.Mock; __data: Record<string, unknown>;
};

beforeEach(() => {
  const data: Record<string, unknown> = {};
  const area = chrome.storage.local as unknown as Record<string, unknown>;
  area.__data = data;
  (area.get as jest.Mock).mockImplementation(async (key: string) => ({ [key]: data[key] }));
  (area.set as jest.Mock).mockImplementation(async (items: Record<string, unknown>) => { Object.assign(data, items); });
});

describe('the unsaved-capture record', () => {
  it('is absent until a capture starts, and gone once the run is accounted for', async () => {
    expect(await captureMayBeUnsaved()).toBe(false);
    await markCaptureStarted();
    expect(await captureMayBeUnsaved()).toBe(true);
    await markCaptureSettled();
    expect(await captureMayBeUnsaved()).toBe(false);
  });

  it('measures a live run to its last write', async () => {
    const startedAt = Date.now() - 60_000;
    await noteCaptureProgress({ recordedMs: 0, runningSince: startedAt });
    expect(await recordedCaptureDurationMs(startedAt + 32 * 60_000)).toBe(32 * 60_000);
  });

  it('leaves paused spans out, because the banked time already does', async () => {
    const resumedAt = 1_000_000;
    // Ten minutes banked before the pause, two minutes running since the resume.
    await noteCaptureProgress({ recordedMs: 10 * 60_000, runningSince: resumedAt });
    expect(await recordedCaptureDurationMs(resumedAt + 2 * 60_000)).toBe(12 * 60_000);
  });

  it('counts only the banked time while paused', async () => {
    await noteCaptureProgress({ recordedMs: 5 * 60_000, runningSince: null });
    expect(await recordedCaptureDurationMs(Date.now())).toBe(5 * 60_000);
  });

  it('says nothing when there is no record, or nothing was recorded', async () => {
    expect(await recordedCaptureDurationMs(Date.now())).toBeNull();
    await noteCaptureProgress({ recordedMs: 0, runningSince: null });
    expect(await recordedCaptureDurationMs(Date.now())).toBeNull();
  });

  it('ignores a record written by an older build', async () => {
    local().__data.captureMayBeUnsaved = true;
    expect(await captureMayBeUnsaved()).toBe(false);
    expect(await recordedCaptureDurationMs(Date.now())).toBeNull();
  });
});
