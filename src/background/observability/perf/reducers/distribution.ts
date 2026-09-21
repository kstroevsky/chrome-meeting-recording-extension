import type {
  PerfDebugSnapshot,
  PerfDistribution,
  PerfFields,
} from '../../../../shared/perf';
import type { RecordingStream } from '../../../../shared/recording';

export function toNumber(value: PerfFields[string]): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toBoolean(value: PerfFields[string]): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function toRecordingStream(value: PerfFields[string]): RecordingStream | null {
  return value === 'tab' || value === 'mic' || value === 'self-video' ? value : null;
}

function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return round(sorted[index]);
}

export function applyDistribution(
  distribution: PerfDistribution,
  value: number,
  samples: number[]
): void {
  distribution.count += 1;
  distribution.total = round(distribution.total + value);
  distribution.avg = round(distribution.total / distribution.count);
  distribution.p50 = percentile(samples, 0.5);
  distribution.p95 = percentile(samples, 0.95);
  distribution.max = distribution.max == null ? value : Math.max(distribution.max, value);
  distribution.last = value;
}

export function matchingDurationSamples(
  snapshot: Readonly<PerfDebugSnapshot>,
  scope: string,
  event: string,
  stream?: RecordingStream
): number[] {
  return snapshot.entries
    .filter((candidate) =>
      candidate.scope === scope
      && candidate.event === event
      && (stream == null || candidate.fields.stream === stream)
    )
    .map((candidate) => toNumber(candidate.fields.durationMs))
    .filter((value): value is number => value != null);
}
