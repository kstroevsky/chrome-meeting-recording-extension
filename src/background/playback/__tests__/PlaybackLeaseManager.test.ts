/** ADR-0006 §15: tombstone at once, delete the bytes only when nobody is reading. */
import { PlaybackLeaseManager, type PlaybackLeaseState } from '../PlaybackLeaseManager';

function make(initial?: Partial<PlaybackLeaseState>) {
  let state: PlaybackLeaseState = { leases: [], deferred: {}, ...initial };
  const deleteRetained = jest.fn(async () => {});
  const warn = jest.fn();
  const manager = new PlaybackLeaseManager({
    read: async () => state,
    write: async (next) => { state = next; },
    deleteRetained,
    now: () => 1_000,
    warn,
  });
  return { manager, deleteRetained, warn, peek: () => state };
}

describe('acquire', () => {
  it('records a lease for a tab and recording', async () => {
    const { manager, peek } = make();
    await manager.acquire(7, 'r1', ['library/r1/tab.webm']);
    expect(peek().leases).toEqual([
      { tabId: 7, recordingId: 'r1', opfsKeys: ['library/r1/tab.webm'], createdAt: 1_000 },
    ]);
  });

  it('refreshes rather than stacking when the same tab reopens the same recording', async () => {
    const { manager, peek } = make();
    await manager.acquire(7, 'r1', ['a']);
    await manager.acquire(7, 'r1', ['a', 'b']);
    expect(peek().leases).toHaveLength(1);
    expect(peek().leases[0].opfsKeys).toEqual(['a', 'b']);
  });

  it('lets two tabs hold the same recording', async () => {
    const { manager, peek } = make();
    await manager.acquire(7, 'r1', ['a']);
    await manager.acquire(8, 'r1', ['a']);
    expect(peek().leases).toHaveLength(2);
    await expect(manager.isLeased('r1')).resolves.toBe(true);
  });
});

describe('deferred deletion', () => {
  it('holds the bytes while a reader remains, then deletes on release', async () => {
    const { manager, deleteRetained } = make();
    await manager.acquire(7, 'r1', ['library/r1/tab.webm']);
    await manager.defer('r1', ['library/r1/tab.webm']);

    expect(deleteRetained).not.toHaveBeenCalled();

    await expect(manager.releaseTab(7)).resolves.toBe(1);
    expect(deleteRetained).toHaveBeenCalledWith(['library/r1/tab.webm']);
  });

  it('waits for the last reader, not the first', async () => {
    const { manager, deleteRetained } = make();
    await manager.acquire(7, 'r1', ['a']);
    await manager.acquire(8, 'r1', ['a']);
    await manager.defer('r1', ['a']);

    await manager.releaseTab(7);
    expect(deleteRetained).not.toHaveBeenCalled();

    await manager.releaseTab(8);
    expect(deleteRetained).toHaveBeenCalledWith(['a']);
  });

  it('accumulates keys rather than replacing them', async () => {
    const { manager, deleteRetained } = make();
    await manager.acquire(7, 'r1', ['a']);
    await manager.defer('r1', ['a']);
    await manager.defer('r1', ['b', 'a']);

    await manager.releaseTab(7);
    expect(deleteRetained).toHaveBeenCalledWith(['a', 'b']);
  });

  it('leaves a deferral alone while its own recording is still held', async () => {
    const { manager, deleteRetained, peek } = make();
    await manager.acquire(7, 'r1', ['a']);
    await manager.acquire(7, 'r2', ['b']);
    await manager.defer('r2', ['b']);

    // r2 is still held by tab 7, so nothing is freed by releasing nothing.
    await manager.reconcile([7]);
    expect(deleteRetained).not.toHaveBeenCalled();
    expect(peek().deferred).toEqual({ r2: ['b'] });
  });

  it('clears the deferral even when deleting the bytes fails', async () => {
    const { manager, deleteRetained, warn, peek } = make();
    deleteRetained.mockRejectedValueOnce(new Error('disk error'));
    await manager.acquire(7, 'r1', ['a']);
    await manager.defer('r1', ['a']);

    await manager.releaseTab(7);
    // The tombstone already stands; a failure here leaks a file, and the
    // startup reconciler is what collects it.
    expect(peek().deferred).toEqual({});
    expect(warn).toHaveBeenCalled();
  });
});

describe('reconcile', () => {
  it('drops leases whose tab is gone and runs what that unblocks', async () => {
    const { manager, deleteRetained, peek } = make();
    await manager.acquire(7, 'r1', ['a']);
    await manager.acquire(99, 'r2', ['b']);
    await manager.defer('r2', ['b']);

    await expect(manager.reconcile([7])).resolves.toBe(1);
    expect(peek().leases.map((l) => l.tabId)).toEqual([7]);
    expect(deleteRetained).toHaveBeenCalledWith(['b']);
  });

  it('keeps everything when every tab is still open', async () => {
    const { manager, deleteRetained } = make();
    await manager.acquire(7, 'r1', ['a']);
    await expect(manager.reconcile([7, 8])).resolves.toBe(0);
    expect(deleteRetained).not.toHaveBeenCalled();
  });

  it('releasing an unknown tab does nothing', async () => {
    const { manager, deleteRetained } = make();
    await manager.acquire(7, 'r1', ['a']);
    await expect(manager.releaseTab(42)).resolves.toBe(0);
    expect(deleteRetained).not.toHaveBeenCalled();
  });
});

describe('unreadable storage', () => {
  it('reports nothing leased rather than blocking deletion forever', async () => {
    const warn = jest.fn();
    const manager = new PlaybackLeaseManager({
      read: async () => { throw new Error('session storage unavailable'); },
      write: async () => {},
      deleteRetained: jest.fn(async () => {}),
      warn,
    });
    await expect(manager.isLeased('r1')).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
