/**
 * @file background/RetainedMediaReconciler.ts
 *
 * Startup reconciliation between `library/` and recording history (ADR-0006).
 *
 * A promotion moves a file and then writes its location to IndexedDB, and those
 * two steps cannot share a transaction. Rather than pretend otherwise, the
 * design is convergent: promotion is idempotent, and this pass repairs whatever
 * a crash left half-done. It is the same philosophy as the existing orphan
 * recovery, applied to the other side of the split.
 *
 * Deliberately conservative in one direction: it deletes retained media only
 * when it can prove nobody owns it. A file whose owner it cannot explain is
 * kept until a grace period has passed, because the cost of collecting too
 * eagerly is a lost recording and the cost of waiting is some disk.
 */

import type { RecordingHistoryEntry } from '../shared/recordingHistory';
import type { OpfsEntry, OpfsKey } from '../offscreen/storage/opfsLayout';
import { parseLibraryKey } from '../offscreen/storage/opfsLayout';

/** An unowned file is collected only once it is older than this. */
export const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

export type RetainedMediaReconcilerDeps = {
  /**
   * False when `library/` has never been created. Nothing has ever been
   * retained, so there is nothing to collect *and* nothing could have left a
   * stale location behind — the whole pass is skipped, and history is not even
   * opened. That keeps a fresh profile from paying for reconciliation it cannot
   * need.
   */
  hasRetainedLibrary?: () => Promise<boolean>;
  /** Every file directly under `library/<history>/`. */
  listRetained: () => Promise<OpfsEntry[]>;
  /** Reads one history entry, tombstoned ones included. */
  getEntry: (historyId: string) => Promise<RecordingHistoryEntry | undefined>;
  /** Live (non-tombstoned) entries, for the stale-location sweep. */
  listLiveEntries: () => Promise<RecordingHistoryEntry[]>;
  /** True when the key still exists in OPFS. */
  exists: (key: OpfsKey) => Promise<boolean>;
  removeRetained: (key: OpfsKey) => Promise<void>;
  recordLocation: (historyId: string, fileId: string, key: OpfsKey, retainedAt: number) => Promise<void>;
  dropLocation: (historyId: string, fileId: string, key: OpfsKey) => Promise<void>;
  now?: () => number;
  graceMs?: number;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export type ReconcileReport = {
  healthy: number;
  repaired: number;
  collected: number;
  deferred: number;
  staleLocations: number;
};

export async function reconcileRetainedMedia(deps: RetainedMediaReconcilerDeps): Promise<ReconcileReport> {
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const report: ReconcileReport = { healthy: 0, repaired: 0, collected: 0, deferred: 0, staleLocations: 0 };

  if (deps.hasRetainedLibrary && !(await deps.hasRetainedLibrary())) return report;

  for (const entry of await deps.listRetained()) {
    try {
      const owner = parseLibraryKey(entry.key);
      if (!owner) {
        // Not a library path at all; treat it as unowned rather than guessing.
        await collectIfExpired(deps, entry, now(), graceMs, report);
        continue;
      }

      const history = await deps.getEntry(owner.historyId);
      if (!history) {
        await collectIfExpired(deps, entry, now(), graceMs, report);
        continue;
      }
      if (history.deletedAt) {
        // The recording is gone; its internal playback copy goes with it. The
        // user's Downloads and Drive copies are untouched — only extension-owned
        // media is deleted here.
        await deps.removeRetained(entry.key);
        report.collected += 1;
        deps.log?.('Collected retained media for a deleted recording', entry.key);
        continue;
      }

      const file = history.files.find((candidate) => candidate.id === owner.fileId);
      if (!file) {
        await collectIfExpired(deps, entry, now(), graceMs, report);
        continue;
      }
      if (file.locations.some((location) => location.kind === 'opfs' && location.key === entry.key)) {
        report.healthy += 1;
        continue;
      }

      // The move landed but the metadata write did not. The bytes are the
      // evidence, so the metadata is what gets repaired.
      await deps.recordLocation(owner.historyId, owner.fileId, entry.key, entry.lastModifiedMs);
      report.repaired += 1;
      deps.log?.('Repaired a missing retained-media location', entry.key);
    } catch (error) {
      deps.warn?.('Could not reconcile retained media; leaving it in place', entry.key, error);
    }
  }

  // The other direction: history claims a retained copy that is no longer there.
  for (const entry of await deps.listLiveEntries()) {
    for (const file of entry.files) {
      for (const location of file.locations) {
        if (location.kind !== 'opfs') continue;
        try {
          if (await deps.exists(location.key)) continue;
          // Drop the claim rather than the row: a Drive replica may still make
          // this recording playable.
          await deps.dropLocation(entry.id, file.id, location.key);
          report.staleLocations += 1;
          deps.log?.('Dropped a stale retained-media location', location.key);
        } catch (error) {
          deps.warn?.('Could not drop a stale retained-media location', location.key, error);
        }
      }
    }
  }

  return report;
}

async function collectIfExpired(
  deps: RetainedMediaReconcilerDeps,
  entry: OpfsEntry,
  nowMs: number,
  graceMs: number,
  report: ReconcileReport,
): Promise<void> {
  if (nowMs - entry.lastModifiedMs < graceMs) {
    // Young and unexplained: most likely a promotion still in flight, so wait
    // rather than delete a recording out from under it.
    report.deferred += 1;
    return;
  }
  await deps.removeRetained(entry.key);
  report.collected += 1;
  deps.log?.('Collected unowned retained media', entry.key);
}
