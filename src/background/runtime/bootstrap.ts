import {
  configurePerfRuntime,
  PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
  type PerfDebugSnapshot,
} from '../../shared/perf';
import {
  hasUploadsInFlight,
  isBusyPhase,
  RECORDING_SESSION_STORAGE_KEY,
} from '../../shared/recording';
import { getSessionStorageValues } from '../../platform/chrome/storage';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { PerfDebugStore } from '../observability/perf/PerfDebugStore';
import type { TelemetryRuntime } from '../observability/telemetry/TelemetryRuntime';
import type { RecordingSession } from '../recording/session/RecordingSession';
import {
  hydrateLegacySession,
  LEGACY_SESSION_PHASE_KEY,
  LEGACY_SESSION_RUN_CONFIG_KEY,
} from '../recording/session/legacySession';
import type { CriticalWorkCoordinator } from './CriticalWorkCoordinator';
import { startKeepAlive } from './KeepAlive';
import type { StartupRecovery } from './StartupRecovery';

type Logger = {
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
};

type BootstrapDeps = {
  session: RecordingSession;
  offscreen: OffscreenManager;
  telemetry: TelemetryRuntime;
  perfDebugStore: PerfDebugStore;
  criticalWork: CriticalWorkCoordinator;
  startupRecovery: StartupRecovery;
  markSessionHydrated: () => void;
  logger: Logger;
};

/** Hydrates durable runtime state, then performs once-per-browser recovery. */
export async function bootstrapBackground(deps: BootstrapDeps): Promise<void> {
  try {
    const settings = await configurePerfRuntime({
      source: 'background',
      sink: (entry) => deps.perfDebugStore.record(entry),
      telemetrySink: {
        increment: (...args) => deps.telemetry.sink()?.increment(...args),
        measure: (...args) => deps.telemetry.sink()?.measure(...args),
        context: (...args) => deps.telemetry.sink()?.context(...args),
        incident: (...args) => deps.telemetry.sink()?.incident(...args),
        checkpoint: (...args) => deps.telemetry.sink()?.checkpoint(...args),
        flush: (...args) => deps.telemetry.sink()?.flush(...args),
      },
      onSettingsChanged: (nextSettings) => deps.perfDebugStore.setSettings(nextSettings),
    });

    const stored = await getSessionStorageValues([
      RECORDING_SESSION_STORAGE_KEY,
      LEGACY_SESSION_PHASE_KEY,
      LEGACY_SESSION_RUN_CONFIG_KEY,
      PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
    ]);
    deps.perfDebugStore.hydrate(stored?.[PERF_DEBUG_SNAPSHOT_STORAGE_KEY] as PerfDebugSnapshot | undefined);
    deps.perfDebugStore.setSettings(settings);
    const snapshot = deps.session.hydrate(
      stored?.[RECORDING_SESSION_STORAGE_KEY] ?? hydrateLegacySession(stored),
    );

    try {
      await deps.telemetry.initialize(
        isBusyPhase(snapshot.phase) && snapshot.epoch != null ? new Set([snapshot.epoch]) : new Set(),
        new Set(snapshot.uploadJobs?.filter((job) => job.status === 'uploading').map((job) => job.id) ?? []),
      );
    } catch (error) {
      deps.logger.warn('Anonymous telemetry initialization failed (non-fatal):', error);
      deps.telemetry.setEnabled(false);
    }

    if (isBusyPhase(snapshot.phase) || hasUploadsInFlight(snapshot.uploadJobs)) {
      deps.logger.log('SW restarted while offscreen work was active — re-attaching offscreen');
      await deps.offscreen.ensureReady();
      startKeepAlive();
    } else {
      await deps.criticalWork.confirmAnalysisWork();
      if (deps.criticalWork.hasWork()) {
        deps.logger.log('SW restarted while an analysis was active — re-attaching offscreen');
        deps.criticalWork.sync();
      }
    }
  } catch (error) {
    deps.logger.warn('Session re-hydration failed (non-fatal):', error);
  } finally {
    deps.markSessionHydrated();
  }

  await deps.startupRecovery.run();
}
