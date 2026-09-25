/**
 * @file offscreen/analysis/AnalysisJobStateOutbox.ts
 *
 * Durable terminal-state outbox for analysis jobs (HOST-03).
 *
 * **Why this exists at all.** The offscreen document outlives the service
 * worker, so a job can finish while nothing is listening. An entry is written
 * before delivery is attempted and removed only after the background
 * acknowledges it, so the only failure mode left is announcing twice, which is
 * idempotent.
 *
 * **Why IndexedDB and not `chrome.storage.local`.** An offscreen document's
 * `chrome` object exposes `runtime` and nothing else — measured, not assumed:
 * `chrome.storage` is simply absent there. The first version of this outbox
 * used `chrome.storage.local`, and the wrappers in `platform/chrome/storage.ts`
 * degrade to a no-op rather than throw — so every write succeeded and stored
 * nothing, reporting a durability the outbox did not have. IndexedDB belongs to the
 * extension *origin*, which the offscreen document, the service worker and
 * extension pages all share — so it is both writable here and readable by
 * everything that needs to see it.
 *
 * It is a database of its own rather than a store in `recording-history`,
 * because background is that database's only writer and this is not
 * background.
 *
 * One key per job, as before, so two jobs settling at once cannot race each
 * other through a read-modify-write.
 */

import { isTerminalAnalysisJob, normalizeAnalysisJob, type AnalysisJob } from '../../shared/analysis/job';
import { hasStores, openAdditiveDatabase } from '../../shared/storage/openAdditiveDatabase';

const TERMINAL_ANALYSIS_STATE_PREFIX = 'analysisJobState:';

export const ANALYSIS_OUTBOX_DATABASE = 'analysis-job-outbox';
const ANALYSIS_OUTBOX_STORE = 'jobs';
const ANALYSIS_OUTBOX_VERSION = 1;

export interface AnalysisJobStateStorageArea {
  getAll(): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export class AnalysisJobStateOutbox {
  constructor(private readonly area: AnalysisJobStateStorageArea) {}

  async put(job: AnalysisJob): Promise<void> {
    if (!isTerminalAnalysisJob(job)) throw new Error('Only terminal analysis jobs belong in the outbox');
    await this.area.set({ [TERMINAL_ANALYSIS_STATE_PREFIX + job.id]: job });
  }

  async remove(jobId: string): Promise<void> {
    await this.area.remove(TERMINAL_ANALYSIS_STATE_PREFIX + jobId);
  }

  async list(): Promise<AnalysisJob[]> {
    const all = await this.area.getAll();
    const jobs: AnalysisJob[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(TERMINAL_ANALYSIS_STATE_PREFIX)) continue;
      const job = normalizeAnalysisJob(value);
      // A row that survived but is no longer terminal is a damaged write, not a
      // running job: dropping it is safer than replaying "analyzing" forever.
      if (job && isTerminalAnalysisJob(job)) jobs.push(job);
    }
    return jobs;
  }
}

/**
 * An outbox storage area over IndexedDB.
 *
 * When `indexedDB` does not exist at all, every operation succeeds and holds
 * nothing. That is a deliberate choice about what a missing store means:
 * there is then no durable row for an in-memory result to be inconsistent
 * with, so acknowledging must still release the result — whereas a store that
 * exists and *fails* is transient, and the caller holds on and retries.
 */
export function createIndexedDbAnalysisJobStateArea(
  factory: IDBFactory | undefined = typeof indexedDB === 'undefined' ? undefined : indexedDB,
): AnalysisJobStateStorageArea {
  if (!factory) {
    return { getAll: async () => ({}), set: async () => {}, remove: async () => {} };
  }

  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opening ??= openAdditiveDatabase(factory, {
      name: ANALYSIS_OUTBOX_DATABASE,
      version: ANALYSIS_OUTBOX_VERSION,
      upgrade: (database) => {
        if (!database.objectStoreNames.contains(ANALYSIS_OUTBOX_STORE)) {
          database.createObjectStore(ANALYSIS_OUTBOX_STORE);
        }
      },
      isSatisfied: (database) => hasStores(database, [ANALYSIS_OUTBOX_STORE]),
    }).then((database) => {
      // Another context upgrading must not be blocked by a long-lived handle.
      database.onversionchange = () => {
        database.close();
        opening = null;
      };
      return database;
    }, (error) => {
      opening = null;
      throw error;
    });
    return opening;
  };

  const run = async (
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => void,
  ): Promise<void> => {
    const database = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(ANALYSIS_OUTBOX_STORE, mode);
      body(transaction.objectStore(ANALYSIS_OUTBOX_STORE));
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Analysis outbox transaction aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Analysis outbox transaction failed'));
    });
  };

  return {
    async getAll() {
      const entries: Record<string, unknown> = {};
      await run('readonly', (store) => {
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return;
          entries[String(current.key)] = current.value;
          current.continue();
        };
      });
      return entries;
    },
    async set(items) {
      await run('readwrite', (store) => {
        for (const [key, value] of Object.entries(items)) store.put(value, key);
      });
    },
    async remove(key) {
      // Deleting an absent key succeeds, so an acknowledgement replayed after a
      // reconnect is harmless.
      await run('readwrite', (store) => { store.delete(key); });
    },
  };
}

/**
 * Applies a background acknowledgement: releases the durable row, then the
 * in-memory result — **in that order**.
 *
 * If the row cannot be removed, the result must survive with it. A `completed`
 * row replayed with no result behind it would be reported as a lost result and
 * the whole analysis recomputed; keeping both means the next reconnect simply
 * redelivers and is acknowledged again. Returns whether the job was released.
 */
export async function acknowledgeAnalysisJob(
  outbox: Pick<AnalysisJobStateOutbox, 'remove'>,
  held: { acknowledge(jobId: string): void },
  jobId: string,
  warn?: (...args: unknown[]) => void,
): Promise<boolean> {
  try {
    await outbox.remove(jobId);
  } catch (error) {
    warn?.('Could not release an acknowledged analysis state; keeping its result for redelivery', jobId, error);
    return false;
  }
  held.acknowledge(jobId);
  return true;
}

/**
 * How many times a terminal state is written before the result is offered
 * without one, and how long to wait between tries.
 */
export const SEAL_ATTEMPTS = 3;
const SEAL_BACKOFF_MS = 250;

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export type SealOptions = {
  attempts?: number;
  /** Injected so tests do not wait; production uses a real timer. */
  delay?: (ms: number) => Promise<void>;
  warn?: (...args: unknown[]) => void;
};

/**
 * Writes a job's terminal state to the outbox, retrying on its own.
 *
 * **The retries must not depend on anything else happening.** An earlier
 * version counted attempts across call sites and threw to hold the result,
 * expecting a later reconnect to try again — so on a healthy, continuously
 * connected port the third attempt never came, the result was held forever,
 * and the runtime stayed busy forever with it. A bound is only a bound if
 * something drives it.
 */
export async function sealAnalysisJob(
  outbox: Pick<AnalysisJobStateOutbox, 'put'>,
  job: AnalysisJob,
  options: SealOptions = {},
): Promise<boolean> {
  const attempts = options.attempts ?? SEAL_ATTEMPTS;
  const delay = options.delay ?? wait;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await outbox.put(job);
      return true;
    } catch (error) {
      options.warn?.(`Could not persist terminal analysis state (attempt ${attempt} of ${attempts})`, job.id, error);
      if (attempt < attempts) await delay(attempt * SEAL_BACKOFF_MS);
    }
  }
  return false;
}

/** The outbox the offscreen document uses. */
export function createAnalysisJobStateOutbox(): AnalysisJobStateOutbox {
  return new AnalysisJobStateOutbox(createIndexedDbAnalysisJobStateArea());
}
