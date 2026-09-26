import type { IntegrationDeliveryState } from './persistence';

export const INTEGRATION_MAX_AUTOMATIC_ATTEMPTS = 6;
export const INTEGRATION_MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000;

const RETRY_BACKOFF_CAPS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
] as const;

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408
    || status === 425
    || status === 429
    || (status >= 500 && status <= 599);
}

export function classifyHttpFailure(status: number): IntegrationDeliveryState {
  if (isRetryableHttpStatus(status)) return 'retrying';
  if ((status >= 300 && status < 400) || [400, 401, 403, 410, 413].includes(status)) {
    return 'action-required';
  }
  return 'failed';
}

/** Full jitter bounded by the ADR's central retry schedule. */
export function integrationRetryDelayMs(attemptCount: number, random = Math.random): number {
  const retryIndex = Math.max(0, attemptCount - 1);
  const cap = RETRY_BACKOFF_CAPS_MS[Math.min(retryIndex, RETRY_BACKOFF_CAPS_MS.length - 1)];
  return Math.floor(Math.max(0, Math.min(1, random())) * cap);
}

export function clampRetryAfterMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.ceil(value), INTEGRATION_MAX_RETRY_AFTER_MS);
}

