/**
 * Shared unit-test fixtures for recording history.
 *
 * Lives outside `src/` on purpose: `collectCoverageFrom` sweeps `src/**\/*.ts`
 * and only excludes `*.test.ts`, so a non-test helper under `src/` would be
 * reported as untested production code.
 */

import type { StorageMode } from '../../src/shared/recording';
import { contentTypeForRecordingFilename } from '../../src/shared/recordingFormats';
import {
  deliveryFromLegacyFields,
  locationsFromLegacyFields,
  type RecordingHistoryFile,
} from '../../src/shared/recordingHistory';

type LegacyShapedFile =
  Omit<RecordingHistoryFile, 'mimeType' | 'locations' | 'delivery'>
  & Partial<Pick<RecordingHistoryFile, 'mimeType' | 'locations' | 'delivery'>>;

/**
 * Builds a history file from the pre-ADR-0006 single-destination shape, filling
 * the replica fields exactly as the normalizer fills them for a legacy row.
 * Pass `locations` / `delivery` explicitly to describe a post-migration row.
 */
export function historyFile(file: LegacyShapedFile, requested: StorageMode = file.destination): RecordingHistoryFile {
  return {
    mimeType: contentTypeForRecordingFilename(file.filename),
    locations: locationsFromLegacyFields(file),
    delivery: deliveryFromLegacyFields(file, requested),
    ...file,
  };
}
