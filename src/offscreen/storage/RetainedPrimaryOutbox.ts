/**
 * Durable handoff journal for retained external-primary media.
 *
 * Promotion moves bytes from capture staging into the retained library before
 * background history can record their owner. Those writes live in different
 * contexts/databases, so the handoff is replayed until background acknowledges
 * that both the external delivery target and OPFS location are durable.
 */

import type { RecordingStream } from '../../shared/recording';
import type { RetainedPrimaryRequest } from '../RecordingFinalizer';
import { createIndexedDbKeyValueArea, type KeyValueArea } from './indexedDbKeyValueArea';

const RETAINED_PRIMARY_PREFIX = 'retainedPrimary:';
export const RETAINED_PRIMARY_OUTBOX_DATABASE = 'retained-primary-outbox';

export class RetainedPrimaryOutbox {
  constructor(private readonly area: KeyValueArea) {}

  async put(request: RetainedPrimaryRequest): Promise<void> {
    await this.area.set({ [keyOf(request.historyId, request.stream)]: request });
  }

  async remove(historyId: string, stream: RecordingStream): Promise<void> {
    await this.area.remove(keyOf(historyId, stream));
  }

  async list(): Promise<RetainedPrimaryRequest[]> {
    const all = await this.area.getAll();
    const requests: RetainedPrimaryRequest[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(RETAINED_PRIMARY_PREFIX)) continue;
      const request = normalizeRetainedPrimaryRequest(value);
      if (request) requests.push(request);
    }
    return requests;
  }
}

export function createRetainedPrimaryOutbox(): RetainedPrimaryOutbox {
  return new RetainedPrimaryOutbox(createIndexedDbKeyValueArea({
    databaseName: RETAINED_PRIMARY_OUTBOX_DATABASE,
    storeName: 'handoffs',
  }));
}

function keyOf(historyId: string, stream: RecordingStream): string {
  return `${RETAINED_PRIMARY_PREFIX}${encodeURIComponent(historyId)}:${stream}`;
}

function normalizeRetainedPrimaryRequest(value: unknown): RetainedPrimaryRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const historyId = boundedText(candidate.historyId, 256);
  const destinationId = boundedText(candidate.destinationId, 128);
  const filename = boundedText(candidate.filename, 1024);
  const retainedKey = boundedText(candidate.retainedKey, 2048);
  const stream = candidate.stream;
  const bytes = finiteNonNegative(candidate.bytes);
  const retainedAt = finiteNonNegative(candidate.retainedAt);
  const startOffsetMs = candidate.startOffsetMs === undefined
    ? undefined
    : finiteNonNegative(candidate.startOffsetMs);
  if (!historyId || !destinationId || !filename || !retainedKey
      || (stream !== 'tab' && stream !== 'mic' && stream !== 'self-video')
      || bytes == null || retainedAt == null
      || (candidate.startOffsetMs !== undefined && startOffsetMs == null)) return undefined;
  return {
    historyId,
    destinationId,
    stream,
    filename,
    bytes,
    ...(startOffsetMs != null ? { startOffsetMs } : {}),
    retainedKey,
    retainedAt,
  };
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\x00-\x1f\x7f]/.test(normalized)) return undefined;
  return normalized;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
