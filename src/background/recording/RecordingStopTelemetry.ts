import { sendTabMessage } from '../../platform/chrome/tabs';
import type { TelemetrySnapshot } from '../../shared/telemetry';
import type { TelemetryRuntime } from '../observability/telemetry/TelemetryRuntime';

/** Best-effort final content-script telemetry snapshot before recording finalization. */
export async function captureStopTelemetry(
  targetTabId: number | undefined,
  telemetry: TelemetryRuntime | undefined,
): Promise<void> {
  if (typeof targetTabId !== 'number') return;
  try {
    const response = await sendTabMessage<{ snapshot?: TelemetrySnapshot }>(
      targetTabId,
      { type: 'TELEMETRY_GET_SNAPSHOT' },
    );
    if (response?.snapshot) await telemetry?.receive(response.snapshot, true);
  } catch {}
}
