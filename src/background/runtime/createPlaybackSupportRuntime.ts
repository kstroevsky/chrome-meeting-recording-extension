import { removeByKey } from '../../offscreen/storage/opfsLayout';
import { getSessionStorageValues, setSessionStorageValues } from '../../platform/chrome/storage';
import { fetchDriveTokenWithFallback } from '../drive/driveAuth';
import { DrivePlaybackAuthLeaseManager } from '../playback/DrivePlaybackAuthLeaseManager';
import { PlaybackLeaseManager, type PlaybackLeaseState } from '../playback/PlaybackLeaseManager';

const PLAYBACK_LEASE_STORAGE_KEY = 'playbackLeases';

type Logger = { warn: (...args: any[]) => void };

/** Constructs the durable/local helpers used to keep retained playback sources usable. */
export function createPlaybackSupportRuntime(logger: Logger) {
  const playbackLeases = new PlaybackLeaseManager({
    read: async () => (
      await getSessionStorageValues(PLAYBACK_LEASE_STORAGE_KEY)
    )?.[PLAYBACK_LEASE_STORAGE_KEY] as PlaybackLeaseState | undefined,
    write: async (state) => {
      await setSessionStorageValues({ [PLAYBACK_LEASE_STORAGE_KEY]: state });
    },
    deleteRetained: async (keys) => {
      const root = await navigator.storage.getDirectory();
      for (const key of keys) await removeByKey(root, key);
    },
    warn: logger.warn,
  });
  const driveAuthLease = new DrivePlaybackAuthLeaseManager({
    getToken: async (options) => {
      const result = await fetchDriveTokenWithFallback({ refresh: options?.refresh === true });
      if (!result.ok) throw new Error(result.error);
      return result.token;
    },
    warn: logger.warn,
  });
  return { playbackLeases, driveAuthLease };
}
