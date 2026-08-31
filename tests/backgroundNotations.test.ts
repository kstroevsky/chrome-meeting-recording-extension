/**
 * End-to-end notation routing through the real background message listener
 * (ADR-0005).
 *
 * Kept out of `background.test.ts` deliberately: this file needs a working
 * `indexedDB` (`fake-indexeddb/auto`), and providing one changes how the
 * telemetry store behaves during background init — which perturbs the
 * update/reload timing assertions that live over there.
 */
import 'fake-indexeddb/auto';

describe('background notation commands', () => {
  let stopBackgroundKeepAlive: (() => void) | undefined;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    (chrome.storage.session.get as jest.Mock).mockResolvedValue({});
  });

  // The hydrated sessions below are busy, so the background starts its
  // service-worker keep-alive interval. `jest.resetModules()` would otherwise
  // leave one ticking per test against a discarded module instance.
  afterEach(() => {
    stopBackgroundKeepAlive?.();
    stopBackgroundKeepAlive = undefined;
  });

  function makeOffscreenInstance() {
    return {
      onStateChanged: undefined as ((msg: any) => void) | undefined,
      onSaveRequested: undefined as ((msg: any) => void) | undefined,
      hydratePhase: jest.fn(),
      attachPort: jest.fn(),
      ensureReady: jest.fn().mockResolvedValue(undefined),
      stopIfPossibleOnSuspend: jest.fn(),
      rpc: jest.fn().mockResolvedValue({ ok: true }),
      revokeBlobUrl: jest.fn(),
      closeForUpdate: jest.fn().mockResolvedValue(true),
    };
  }

  async function importBackground() {
    jest.doMock('../src/background/driveAuth', () => ({ fetchDriveTokenWithFallback: jest.fn() }));
    jest.doMock('../src/background/OffscreenManager', () => ({
      OffscreenManager: jest.fn(() => makeOffscreenInstance()),
    }));
    await import('../src/background');
    // The bootstrap IIFE initializes telemetry, which with a real `indexedDB`
    // resolves over several macrotask turns. Anything still pending when the
    // test ends logs after teardown, which Jest reports as a failed run even
    // though every assertion passed — so drain it before handing back.
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    ({ stopKeepAlive: stopBackgroundKeepAlive } = await import('../src/background/sessionLifecycle'));
    return (chrome.runtime.onMessage.addListener as jest.Mock).mock.calls[0][0];
  }

  /** Hydrates a live recording whose clock started `elapsedMs` ago. */
  const recordingSince = (elapsedMs: number) => ({
    recordingSession: {
      phase: 'recording',
      desired: 'recording',
      observed: 'recording',
      failed: false,
      runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
      historyId: `recording:it-${Math.random().toString(36).slice(2)}`,
      epoch: 1,
      recordedMs: 0,
      runningSince: Date.now() - elapsedMs,
      updatedAt: Date.now(),
    },
  });

  const send = (listener: any, message: unknown) =>
    new Promise<any>((resolve) => { listener(message, {}, resolve); });

  it('marks and lists a notation through the real message listener', async () => {
    const hydrated = recordingSince(6_000);
    (chrome.storage.session.get as jest.Mock).mockResolvedValue(hydrated);
    const listener = await importBackground();

    const marked = await send(listener, { type: 'MARK_NOTATION', text: 'demo starts' });

    expect(marked).toEqual({
      ok: true,
      notation: { id: expect.stringMatching(/^notation:/), tStartMs: expect.any(Number), text: 'demo starts' },
    });
    // Stamped from the live pause-aware clock, not from zero.
    expect(marked.notation.tStartMs).toBeGreaterThanOrEqual(6_000);

    const listed = await send(listener, {
      type: 'LIST_RECORDING_NOTATIONS',
      recordingId: hydrated.recordingSession.historyId,
    });
    expect(listed).toEqual({ ok: true, notations: [marked.notation] });
  });

  it('closes an open mark and keeps the list at one entry', async () => {
    const hydrated = recordingSince(2_000);
    (chrome.storage.session.get as jest.Mock).mockResolvedValue(hydrated);
    const listener = await importBackground();

    const marked = await send(listener, { type: 'MARK_NOTATION' });
    const ended = await send(listener, { type: 'END_NOTATION', id: marked.notation.id });

    expect(ended.ok).toBe(true);
    expect(ended.notation.tEndMs).toBeGreaterThanOrEqual(marked.notation.tStartMs);

    const listed = await send(listener, {
      type: 'LIST_RECORDING_NOTATIONS',
      recordingId: hydrated.recordingSession.historyId,
    });
    expect(listed.notations).toHaveLength(1);
    expect(listed.notations[0].tEndMs).toBe(ended.notation.tEndMs);
  });

  it('adds, updates, and removes a notation on a finished recording', async () => {
    const listener = await importBackground();
    const recordingId = 'recording:finished';

    const added = await send(listener, {
      type: 'ADD_RECORDING_NOTATION', recordingId, tStartMs: 12_500, tEndMs: 41_000, text: 'Intro / agenda',
    });
    expect(added).toEqual({
      ok: true,
      notation: { id: expect.any(String), tStartMs: 12_500, tEndMs: 41_000, text: 'Intro / agenda' },
    });

    const updated = await send(listener, {
      type: 'UPDATE_RECORDING_NOTATION', recordingId, id: added.notation.id, text: 'Agenda',
    });
    expect(updated.notations).toEqual([{ ...added.notation, text: 'Agenda' }]);

    const removed = await send(listener, {
      type: 'REMOVE_RECORDING_NOTATION', recordingId, id: added.notation.id,
    });
    expect(removed).toEqual({ ok: true, notations: [] });
  });

  it('rejects a malformed notation request without failing the recording session', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue(recordingSince(3_000));
    const listener = await importBackground();

    const response = await send(listener, { type: 'ADD_RECORDING_NOTATION', recordingId: 'recording:1' });

    expect(response).toEqual({ ok: false, error: expect.stringContaining('Malformed recording notation request') });
    expect(response.session).toBeUndefined();

    // The regression this pins: routing a data-plane failure down the command
    // branch would call session.fail() and take the live recording with it.
    const status = await send(listener, { type: 'GET_RECORDING_STATUS' });
    expect(status.session.phase).toBe('recording');
    expect(status.session.error).toBeUndefined();
  });

  it('reports an unknown notation id without failing the recording session', async () => {
    (chrome.storage.session.get as jest.Mock).mockResolvedValue(recordingSince(3_000));
    const listener = await importBackground();

    const response = await send(listener, {
      type: 'REMOVE_RECORDING_NOTATION', recordingId: 'recording:absent', id: 'notation:absent',
    });

    expect(response).toEqual({ ok: false, error: expect.stringContaining('Unknown notation') });

    const status = await send(listener, { type: 'GET_RECORDING_STATUS' });
    expect(status.session.phase).toBe('recording');
  });

  it('refuses to mark while idle without failing the session', async () => {
    const listener = await importBackground();

    const response = await send(listener, { type: 'MARK_NOTATION', text: 'too early' });

    expect(response).toEqual({ ok: false, error: 'Mark requested but no recording is active' });

    const status = await send(listener, { type: 'GET_RECORDING_STATUS' });
    expect(status.session.phase).toBe('idle');
  });
});
