import {
  ANALYSIS_RECONCILIATION_ALARM,
  AnalysisReconciliationScheduler,
} from '../AnalysisReconciliationScheduler';

describe('AnalysisReconciliationScheduler', () => {
  it('advances one bounded page and schedules an immediate continuation', async () => {
    let cursor: string | undefined = 'rec:025';
    const reconciled: string[][] = [];
    const alarms: Array<{ name: string; when: number }> = [];
    const scheduler = new AnalysisReconciliationScheduler({
      listRecordingIds: async (limit, after) => {
        expect(limit).toBe(25);
        expect(after).toBe('rec:025');
        return { recordingIds: ['rec:026', 'rec:027'], nextCursor: 'rec:050' };
      },
      reconcile: async (ids) => { reconciled.push(ids); },
      readCursor: async () => cursor,
      writeCursor: async (value) => { cursor = value; },
      createAlarm: async (name, info) => { alarms.push({ name, when: info.when! }); },
      getAlarm: async () => undefined,
      now: () => 10_000,
    });

    await scheduler.runSlice();

    expect(reconciled).toEqual([['rec:026', 'rec:027']]);
    expect(cursor).toBe('rec:050');
    expect(alarms).toEqual([{ name: ANALYSIS_RECONCILIATION_ALARM, when: 11_000 }]);
  });

  it('resets the cursor and schedules a later repair sweep after the last page', async () => {
    let cursor: string | undefined = 'rec:050';
    const alarms: number[] = [];
    const scheduler = new AnalysisReconciliationScheduler({
      listRecordingIds: async () => ({ recordingIds: ['rec:051'] }),
      reconcile: async () => {},
      readCursor: async () => cursor,
      writeCursor: async (value) => { cursor = value; },
      createAlarm: async (_name, info) => { alarms.push(info.when!); },
      getAlarm: async () => undefined,
      now: () => 20_000,
    });

    await scheduler.runSlice();

    expect(cursor).toBeUndefined();
    expect(alarms).toEqual([20_000 + 15 * 60_000]);
  });

  it('keeps the cursor on failure and leaves a bounded retry wake', async () => {
    let cursor: string | undefined = 'rec:025';
    const writes: Array<string | undefined> = [];
    const alarms: number[] = [];
    const scheduler = new AnalysisReconciliationScheduler({
      listRecordingIds: async () => ({ recordingIds: ['rec:026'], nextCursor: 'rec:050' }),
      reconcile: async () => { throw new Error('database unavailable'); },
      readCursor: async () => cursor,
      writeCursor: async (value) => { writes.push(value); cursor = value; },
      createAlarm: async (_name, info) => { alarms.push(info.when!); },
      getAlarm: async () => undefined,
      now: () => 30_000,
    });

    await expect(scheduler.runSlice()).rejects.toThrow('database unavailable');

    expect(cursor).toBe('rec:025');
    expect(writes).toEqual([]);
    expect(alarms).toEqual([90_000]);
  });

  it('coalesces concurrent wakes so one cursor page is not processed twice', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let pages = 0;
    const scheduler = new AnalysisReconciliationScheduler({
      listRecordingIds: async () => {
        pages += 1;
        await gate;
        return { recordingIds: [] };
      },
      reconcile: async () => {},
      readCursor: async () => undefined,
      writeCursor: async () => {},
      createAlarm: async () => {},
      getAlarm: async () => undefined,
    });

    const first = scheduler.runSlice();
    const second = scheduler.runSlice();
    release();
    await Promise.all([first, second]);

    expect(pages).toBe(1);
  });
});
