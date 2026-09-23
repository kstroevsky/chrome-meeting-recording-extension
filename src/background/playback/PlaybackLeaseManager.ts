/**
 * @file background/playback/PlaybackLeaseManager.ts
 *
 * Stops a recording's retained bytes being deleted while someone is watching
 * them (ADR-0006 §15).
 *
 * An OPFS `File` stays tied to its underlying storage object, so deleting a
 * retained recording out from under an open player breaks playback mid-frame.
 * A lease says "this tab is reading these bytes"; deletion tombstones the
 * history row immediately either way — the user's intent is honoured at once —
 * and defers only the byte removal until the last reader goes away.
 *
 * State lives in `chrome.storage.session` rather than in memory because the MV3
 * worker is evicted constantly while a player tab stays open, and it lives in
 * *session* storage rather than local because a lease must not outlive the
 * browser: the tab it names will not.
 */

export type PlaybackLease = {
  tabId: number;
  recordingId: string;
  opfsKeys: string[];
  createdAt: number;
};

export type PlaybackLeaseState = {
  leases: PlaybackLease[];
  /** Recording id -> keys awaiting a reader to leave. */
  deferred: Record<string, string[]>;
};

const EMPTY: PlaybackLeaseState = { leases: [], deferred: {} };

export type PlaybackLeaseManagerDeps = {
  read: () => Promise<PlaybackLeaseState | undefined>;
  write: (state: PlaybackLeaseState) => Promise<void>;
  deleteRetained: (keys: string[]) => Promise<void>;
  now?: () => number;
  warn?: (...args: unknown[]) => void;
};

export class PlaybackLeaseManager {
  private readonly now: () => number;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PlaybackLeaseManagerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** One lease per tab-and-recording; re-acquiring refreshes rather than stacks. */
  async acquire(tabId: number, recordingId: string, opfsKeys: string[]): Promise<void> {
    await this.mutate(async () => {
      const state = await this.state();
      const leases = state.leases.filter((lease) => !(lease.tabId === tabId && lease.recordingId === recordingId));
      leases.push({ tabId, recordingId, opfsKeys, createdAt: this.now() });
      await this.deps.write({ ...state, leases });
    });
  }

  async isLeased(recordingId: string): Promise<boolean> {
    return (await this.state()).leases.some((lease) => lease.recordingId === recordingId);
  }

  /**
   * Records a deletion that could not happen yet. Keys accumulate rather than
   * replace: a recording can be leased by two tabs holding different tracks.
   */
  async defer(recordingId: string, keys: string[]): Promise<void> {
    await this.mutate(async () => {
      const state = await this.state();
      await this.writeDeferral(state, recordingId, keys);
    });
  }

  /** Atomically decides whether deletion may run or must wait for readers. */
  async deleteOrDefer(recordingId: string, keys: string[]): Promise<'deleted' | 'deferred'> {
    return this.mutate(async () => {
      const state = await this.state();
      if (state.leases.some((lease) => lease.recordingId === recordingId)) {
        await this.writeDeferral(state, recordingId, keys);
        return 'deferred' as const;
      }
      await this.deps.deleteRetained(keys);
      return 'deleted' as const;
    });
  }

  /** Releases a tab's leases and runs whatever that unblocks. */
  async releaseTab(tabId: number): Promise<number> {
    return this.mutate(async () => {
      const state = await this.state();
      const leases = state.leases.filter((lease) => lease.tabId !== tabId);
      if (leases.length === state.leases.length) return 0;
      return this.drain({ ...state, leases });
    });
  }

  async release(tabId: number, recordingId: string): Promise<number> {
    return this.mutate(async () => {
      const state = await this.state();
      const leases = state.leases.filter(
        (lease) => !(lease.tabId === tabId && lease.recordingId === recordingId),
      );
      if (leases.length === state.leases.length) return 0;
      return this.drain({ ...state, leases });
    });
  }

  /**
   * Drops leases whose tab is gone. Session state survives a worker restart but
   * tabs do not, so without this a crashed player would pin its bytes forever.
   */
  async reconcile(liveTabIds: readonly number[]): Promise<number> {
    return this.mutate(async () => {
      const live = new Set(liveTabIds);
      const state = await this.state();
      const leases = state.leases.filter((lease) => live.has(lease.tabId));
      return this.drain({ ...state, leases });
    });
  }

  /** Deletes everything no longer held, and returns how many recordings that freed. */
  private async drain(state: PlaybackLeaseState): Promise<number> {
    const held = new Set(state.leases.map((lease) => lease.recordingId));
    const deferred = { ...state.deferred };
    let freed = 0;
    for (const [recordingId, keys] of Object.entries(deferred)) {
      if (held.has(recordingId)) continue;
      delete deferred[recordingId];
      freed += 1;
      try {
        await this.deps.deleteRetained(keys);
      } catch (error) {
        // The tombstone already stands, so a failed delete is a leaked file, not
        // a resurrected recording. The startup reconciler collects it later.
        this.deps.warn?.('Deferred retained-media deletion failed', recordingId, error);
      }
    }
    await this.deps.write({ leases: state.leases, deferred });
    return freed;
  }

  private async state(): Promise<PlaybackLeaseState> {
    try {
      const stored = await this.deps.read();
      return stored ? { leases: stored.leases ?? [], deferred: stored.deferred ?? {} } : { ...EMPTY };
    } catch (error) {
      this.deps.warn?.('Could not read playback leases', error);
      throw error;
    }
  }

  private async writeDeferral(
    state: PlaybackLeaseState,
    recordingId: string,
    keys: string[],
  ): Promise<void> {
    const existing = state.deferred[recordingId] ?? [];
    await this.deps.write({
      ...state,
      deferred: { ...state.deferred, [recordingId]: [...new Set([...existing, ...keys])] },
    });
  }

  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.catch(() => {}).then(work);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}
