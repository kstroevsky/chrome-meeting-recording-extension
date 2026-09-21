/**
 * @file background/perf/CpuSampler.ts
 *
 * Diagnostics-only, system-wide CPU utilization sampler. Reads the cumulative
 * per-core tick counters from `chrome.system.cpu` and derives a utilization
 * percentage from the delta between two reads.
 *
 * This is a DEV-ONLY signal: the `"system.cpu"` permission is injected into the
 * manifest only for development builds (see webpack `transformManifest`), so in
 * production `chrome.system.cpu` is undefined, `createChromeCpuSampler()`
 * returns `null`, and no CPU sampling happens. The reading is *system-wide*
 * (every process on the machine, not just this extension), so treat it as a
 * coarse, directional load signal — it answers "was the machine busy?", not
 * "how much CPU did the recorder use?".
 */

/** Minimal shape of `chrome.system.cpu` `CpuInfo` that we depend on (structurally compatible). */
type CpuUsageSnapshot = {
  processors: Array<{ usage: { idle: number; total: number } }>;
};

export type CpuInfoReader = () => Promise<CpuUsageSnapshot>;

export class CpuSampler {
  private prevIdle: number | null = null;
  private prevTotal: number | null = null;

  constructor(private readonly read: CpuInfoReader) {}

  /**
   * Returns system-wide CPU utilization (0–100, one decimal) since the previous
   * call, or `null` on the first call (no baseline yet), on a read error, or
   * when the cumulative counters did not advance.
   */
  async sample(): Promise<number | null> {
    let info: CpuUsageSnapshot;
    try {
      info = await this.read();
    } catch {
      return null;
    }

    let idle = 0;
    let total = 0;
    for (const p of info?.processors ?? []) {
      idle += p?.usage?.idle ?? 0;
      total += p?.usage?.total ?? 0;
    }
    if (!(total > 0)) return null;

    const prevIdle = this.prevIdle;
    const prevTotal = this.prevTotal;
    this.prevIdle = idle;
    this.prevTotal = total;
    if (prevIdle == null || prevTotal == null) return null;

    const deltaTotal = total - prevTotal;
    const deltaIdle = idle - prevIdle;
    if (!(deltaTotal > 0)) return null;

    const pct = 100 * (1 - deltaIdle / deltaTotal);
    return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
  }
}

/**
 * Builds a `CpuSampler` bound to `chrome.system.cpu` when the permission is
 * present (development builds). Returns `null` in production / any context
 * without the API, so callers can treat CPU sampling as optional.
 */
export function createChromeCpuSampler(): CpuSampler | null {
  const cpu = (globalThis as any)?.chrome?.system?.cpu;
  if (!cpu || typeof cpu.getInfo !== 'function') return null;
  return new CpuSampler(() => cpu.getInfo());
}
