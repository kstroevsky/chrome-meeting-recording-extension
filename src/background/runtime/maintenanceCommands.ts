/**
 * @file background/runtime/maintenanceCommands.ts
 *
 * One-off library repairs the UI has no screen for, run from the service
 * worker's DevTools console (chrome://extensions → "service worker"). Each
 * command only plans unless its last argument is `true`, so the plan can be
 * read before anything is written:
 *
 *   await recorderMaintenance.importDriveDestination('Therapy')        // plan
 *   await recorderMaintenance.importDriveDestination('Therapy', true)  // apply
 *   await recorderMaintenance.backfillDriveFolders()                   // plan
 *   await recorderMaintenance.backfillDriveFolders(true)               // apply
 *   await recorderMaintenance.restoreDeletedRecording('Therapy', '<folder>')        // plan
 *   await recorderMaintenance.restoreDeletedRecording('Therapy', '<folder>', true)  // apply
 *   await recorderMaintenance.setRecordingDurations([{ id, durationMs }, …])        // plan
 *   await recorderMaintenance.setRecordingDurations([…], true)                      // apply
 *   await recorderMaintenance.repointRecordingVideo('<entry name>', '<video file name or id>')        // plan
 *   await recorderMaintenance.repointRecordingVideo('<entry name>', '<video file name or id>', true)  // apply
 */

import type { DriveLibraryCoordinator } from '../drive/DriveLibraryCoordinator';
import { fetchDriveFileMetadata, LibraryRepairs, listDriveFolderFiles } from '../drive/LibraryRepairs';

export function exposeMaintenanceCommands(driveLibrary: DriveLibraryCoordinator): void {
  const repairs = new LibraryRepairs({
    history: driveLibrary.historyRepository,
    getDriveFile: fetchDriveFileMetadata,
    listDriveFolder: listDriveFolderFiles,
    log: (...args) => console.log(...args),
  });
  (globalThis as { recorderMaintenance?: unknown }).recorderMaintenance = {
    async setRecordingDurations(durations: Array<{ id: string; durationMs: number }>, apply = false) {
      const result = await repairs.setDurations(durations, { apply });
      const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;
      console.log(`${result.applied ? 'APPLIED' : 'PLAN (nothing written)'}: duration for ${result.set.length}, ${result.skipped.length} left alone.`);
      if (result.set.length) console.table(result.set.map(({ name, durationMs }) => ({ recording: name, duration: fmt(durationMs) })));
      if (result.skipped.length) console.table(result.skipped);
      if (!result.applied) console.log('To apply: run the same command with `, true` added.');
      return { applied: result.applied, set: result.set.length, skipped: result.skipped.length };
    },
    async repointRecordingVideo(entryName: string, video: string, apply = false) {
      const result = await repairs.repointVideo(entryName, video, { apply });
      console.log(`${result.applied ? 'APPLIED' : 'PLAN (nothing written)'}: "${result.entry}" plays ${result.to} instead of ${result.from}.`);
      if (!result.applied) console.log('To apply: run the same command with `, true` added.');
      return result;
    },
    async importDriveDestination(destinationName: string, apply = false) {
      const { applied, plan } = await driveLibrary.importer.importDestination(destinationName, { apply });
      console.log(`${applied ? 'APPLIED' : 'PLAN (nothing written)'}: ${plan.create.length} new, `
        + `${plan.relink.length} re-linked, ${plan.skipped.length} left alone.`);
      if (plan.create.length) {
        console.table(plan.create.map((entry) => ({
          recording: entry.name,
          started: new Date(entry.createdAt).toISOString(),
          streams: entry.files.map((file) => file.stream).join('+'),
        })));
      }
      if (plan.relink.length) console.table(plan.relink);
      if (plan.skipped.length) console.table(plan.skipped);
      if (!applied) console.log(`To apply: await recorderMaintenance.importDriveDestination(${JSON.stringify(destinationName)}, true)`);
      return { applied, created: plan.create.length, relinked: plan.relink.length, skipped: plan.skipped.length };
    },
    async restoreDeletedRecording(destinationName: string, folderName: string, apply = false) {
      const { applied, restored } = await driveLibrary.importer.restoreFolder(destinationName, folderName, { apply });
      console.log(`${applied ? 'RESTORED' : 'PLAN (nothing written)'}: "${restored.name}" back into the library, `
        + `filed under ${destinationName}. Its notes, transcript and analysis were deleted with it and do not come back.`);
      if (!applied) {
        console.log(`To apply: await recorderMaintenance.restoreDeletedRecording(${JSON.stringify(destinationName)}, ${JSON.stringify(folderName)}, true)`);
      }
      return { applied, ...restored };
    },
    async backfillDriveFolders(apply = false) {
      const { applied, plan } = await driveLibrary.folderBackfill.run({ apply });
      console.log(`${applied ? 'APPLIED' : 'PLAN (nothing written)'}: folder recorded for ${plan.backfill.length}, `
        + `${plan.skipped.length} left alone.`);
      if (plan.backfill.length) {
        console.table(plan.backfill.map(({ recording, folderName, destination }) => ({ recording, folder: folderName, destination })));
      }
      if (plan.skipped.length) console.table(plan.skipped);
      if (!applied) console.log('To apply: await recorderMaintenance.backfillDriveFolders(true)');
      return { applied, recorded: plan.backfill.length, skipped: plan.skipped.length };
    },
  };
}
