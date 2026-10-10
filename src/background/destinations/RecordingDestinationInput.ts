import type {
  RecordingDestinationMediaTarget,
  RecordingDestinationRoute,
} from '../../shared/recordingDestinations';

type SaveRecordingDestinationBaseInput = {
  id?: string;
  name?: string;
};

/** Kept so existing callers and stored V1 setup flows continue to work. */
export type LegacySaveRecordingDestinationInput = SaveRecordingDestinationBaseInput & {
  destinationId: string;
  localFolderPresetId?: string;
};

/** M3/M5 profile editor payload. */
export type GeneralSaveRecordingDestinationInput = SaveRecordingDestinationBaseInput & {
  mediaTarget: RecordingDestinationMediaTarget;
  dataRoutes: RecordingDestinationRoute[];
};

export type SaveRecordingDestinationInput =
  | LegacySaveRecordingDestinationInput
  | GeneralSaveRecordingDestinationInput;

export function normalizeSaveInput(input: SaveRecordingDestinationInput): {
  mediaTarget: RecordingDestinationMediaTarget;
  dataRoutes: RecordingDestinationRoute[];
} {
  if ('mediaTarget' in input) {
    return {
      mediaTarget: { ...input.mediaTarget },
      dataRoutes: input.dataRoutes.map((route) => ({ destinationId: route.destinationId, mode: route.mode })),
    };
  }
  return {
    mediaTarget: {
      kind: 'local',
      ...(input.localFolderPresetId ? { folderPresetId: input.localFolderPresetId } : {}),
    },
    dataRoutes: [{ destinationId: input.destinationId, mode: 'auto' }],
  };
}
