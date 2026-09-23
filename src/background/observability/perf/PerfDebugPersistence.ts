import type { PerfDebugSnapshot } from '../../../shared/perf';
import { PERF_DEBUG_SNAPSHOT_STORAGE_KEY } from '../../../shared/perf';
import {
  hasSessionStorageArea,
  removeSessionStorageValues,
  setSessionStorageValues,
} from '../../../platform/chrome/storage';

export class PerfDebugPersistence {
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly warn: (...args: any[]) => void = () => {}) {}

  schedule(getSnapshot: () => PerfDebugSnapshot, delayMs = 400): void {
    if (!hasSessionStorageArea()) return;
    if (delayMs === 0) {
      this.cancelTimer();
      this.persist(getSnapshot());
      return;
    }

    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist(getSnapshot());
    }, delayMs);
  }

  clear(): void {
    this.cancelTimer();
    if (!hasSessionStorageArea()) return;
    void removeSessionStorageValues(PERF_DEBUG_SNAPSHOT_STORAGE_KEY)
      .catch((error: any) => this.warn('Failed to clear perf debug snapshot', error));
  }

  private persist(snapshot: PerfDebugSnapshot): void {
    void setSessionStorageValues({ [PERF_DEBUG_SNAPSHOT_STORAGE_KEY]: snapshot })
      .catch(() => {
        void setSessionStorageValues({
          [PERF_DEBUG_SNAPSHOT_STORAGE_KEY]: { ...snapshot, entries: [] },
        }).catch((error: any) => this.warn('Failed to persist perf debug snapshot', error));
      });
  }

  private cancelTimer(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }
}
