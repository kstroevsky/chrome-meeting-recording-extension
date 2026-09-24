import type { RecordingSnapshotEventData, StructuredCloudEvent } from './contracts';
import { stableJsonSerialize, utf8ByteLength } from './serialization';

/** Initial V1 guardrail. Revisit with receiver evidence; never bypass the guard. */
export const INTEGRATION_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

export type IntegrationPayloadMeasurement = {
  body: string;
  totalBytes: number;
  transcriptBytes: number;
  otherBytes: number;
};

export function measureIntegrationPayload(
  event: StructuredCloudEvent<RecordingSnapshotEventData>,
): IntegrationPayloadMeasurement {
  const body = stableJsonSerialize(event);
  const totalBytes = utf8ByteLength(body);
  const transcriptBytes = event.data.recording.transcript
    ? utf8ByteLength(stableJsonSerialize(event.data.recording.transcript))
    : 0;
  return {
    body,
    totalBytes,
    transcriptBytes,
    otherBytes: totalBytes - transcriptBytes,
  };
}

export function assertIntegrationPayloadWithinLimit(
  measurement: IntegrationPayloadMeasurement,
  maxBytes: number,
): void {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Invalid integration payload limit');
  if (measurement.totalBytes <= maxBytes) return;
  throw new IntegrationPayloadTooLargeError(measurement, maxBytes);
}

export class IntegrationPayloadTooLargeError extends Error {
  constructor(
    readonly measurement: IntegrationPayloadMeasurement,
    readonly maxBytes: number,
  ) {
    super(`Integration payload is ${measurement.totalBytes} bytes; limit is ${maxBytes}`);
    this.name = 'IntegrationPayloadTooLargeError';
  }
}
