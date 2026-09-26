/**
 * @file background/drive/DriveLibrarySync.ts
 *
 * "Sync with Drive": bring the library back in line with what is in the Drive
 * folders, as a preview the user confirms.
 *
 * What it looks at: every recording folder inside every destination (the
 * default one and each the user named). What it offers:
 *  - moves: entries whose folder moved or was re-filed in Drive, re-pointed and
 *    re-tagged by where the folder is now (and older entries with no folder
 *    recorded, given theirs);
 *  - not in the library: folders whose recording the user removed, or that the
 *    library never had — each offered, never brought back unasked;
 *  - missing: entries whose Drive files are gone or in the trash — reported
 *    only; removing them stays the user's call;
 *  - durations: filled in from the files themselves, for entries without one.
 *
 * `apply` plans again against Drive as it is then, and does only what the user
 * chose from the preview — so nothing stale is ever written.
 */

import { DRIVE_DEFAULT_DESTINATION_NAME, loadExtensionSettingsFromStorage } from '../../shared/settings';
import { createRecordingHistoryId, type RecordingHistoryEntry } from '../../shared/recordingHistory';
import { probeWebmHead, probeWebmTail, webmDurationMs } from '../../shared/webmProbe';
import type { DriveSyncChoice, DriveSyncPlan, DriveSyncResult } from '../../shared/driveSync';
import type { RecordingHistoryMutation } from '../library/history/RecordingHistoryRepository';
import type { DriveFolder } from './DriveDestinationFiler';
import type { DriveFolderBackfill } from './DriveFolderBackfill';
import {
  planDestinationImport,
  relinkedEntry,
  restoreDeletedEntry,
  type DestinationImportPlan,
  type DriveListedFile,
} from './driveDestinationImport';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const HEAD_BYTES = 65_536;
const TAIL_BYTES = 262_144;
const MAX_DURATION_MS = 12 * 60 * 60 * 1000;
/** Drive requests in flight at once: a few, so a large library is quick without hammering Drive. */
const CONCURRENCY = 5;

/** `work` over `items`, `CONCURRENCY` at a time, results in the items' order. */
async function mapLimited<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, lane));
  return results;
}

export type DriveLibrarySyncDeps = {
  findFolder: (name: string, parentId: string | null) => Promise<DriveFolder | null>;
  listChildren: (folderId: string) => Promise<Array<DriveListedFile & { mimeType?: string }>>;
  /** A Drive file as the extension sees it now. */
  fileState: (fileId: string) => Promise<'ok' | 'trashed' | 'missing'>;
  /** Bytes [from, to] of a Drive file, or null when unreadable. */
  readRange: (fileId: string, from: number, to: number) => Promise<Uint8Array | null>;
  history: {
    listAllIncludingDeleted: () => Promise<RecordingHistoryEntry[]>;
    update: (id: string, mutate: RecordingHistoryMutation) => Promise<RecordingHistoryEntry | undefined>;
  };
  backfill: Pick<DriveFolderBackfill, 'run'>;
  log: (...args: unknown[]) => void;
};

type Destination = { name: string; presetId?: string; plan: DestinationImportPlan; sizes: Map<string, number> };

export class DriveLibrarySync {
  constructor(private readonly deps: DriveLibrarySyncDeps) {}

  async plan(): Promise<DriveSyncPlan> {
    return (await this.survey()).plan;
  }

  async apply(choice: DriveSyncChoice): Promise<DriveSyncResult> {
    const { destinations, durationCandidates } = await this.survey();
    const result: DriveSyncResult = { moved: 0, broughtBack: 0, durations: 0, durationsUnreadable: 0 };
    const live = (current: RecordingHistoryEntry | undefined) => current && !current.deletedAt;

    for (const { plan, presetId } of destinations) {
      if (choice.moves) {
        for (const link of plan.relink) {
          const folder = { id: link.folderId, name: link.folderName };
          await this.deps.history.update(link.historyId, (current) => (live(current) ? relinkedEntry(current!, folder, presetId) : current));
          result.moved += 1;
        }
      }
      for (const removed of plan.removed.filter((item) => choice.bringBack.includes(item.folderId))) {
        const folder = { id: removed.folderId, name: removed.folderName };
        await this.deps.history.update(removed.historyId, (current) => (current?.deletedAt ? restoreDeletedEntry(current, folder, presetId) : current));
        result.broughtBack += 1;
      }
      for (const entry of plan.create.filter((item) => choice.bringBack.includes(item.driveFolderId!))) {
        await this.deps.history.update(entry.id, (current) => current ?? entry);
        result.broughtBack += 1;
      }
    }
    if (choice.moves) result.moved += (await this.deps.backfill.run({ apply: true })).plan.backfill.length;

    if (choice.durations) {
      const read = await mapLimited(durationCandidates, async (candidate) => ({
        ...candidate,
        durationMs: await this.readDuration(candidate.fileId, candidate.size).catch(() => null),
      }));
      for (const { entry, durationMs } of read) {
        if (durationMs == null) { result.durationsUnreadable += 1; continue; }
        await this.deps.history.update(entry.id, (current) => (live(current) && current!.durationMs == null ? { ...current!, durationMs } : current));
        result.durations += 1;
      }
    }
    this.deps.log(`Drive sync: ${result.moved} moved, ${result.broughtBack} brought back, ${result.durations} durations`);
    return result;
  }

  private async survey() {
    const settings = await loadExtensionSettingsFromStorage();
    const root = await this.deps.findFolder(settings.storage.driveRootFolderName, null);
    if (!root) throw new Error(`No "${settings.storage.driveRootFolderName}" folder in Google Drive`);
    const entries = await this.deps.history.listAllIncludingDeleted();

    const destinations: Destination[] = [];
    const seen = new Set<string>();
    const named = [
      { name: DRIVE_DEFAULT_DESTINATION_NAME, presetId: undefined as string | undefined },
      ...settings.storage.driveFolderPresets.map((preset) => ({ name: preset.name, presetId: preset.id })),
    ];
    for (const { name, presetId } of named) {
      const folder = await this.deps.findFolder(name, root.id);
      if (!folder) continue;
      const sizes = new Map<string, number>();
      const children = (await this.deps.listChildren(folder.id)).filter((child) => child.mimeType === FOLDER_MIME);
      const folders = await mapLimited(children, async (child) => ({
        id: child.id,
        name: child.name,
        files: (await this.deps.listChildren(child.id)).filter((file) => file.mimeType !== FOLDER_MIME),
      }));
      for (const file of folders.flatMap((recording) => recording.files)) {
        seen.add(file.id);
        if (file.size != null) sizes.set(file.id, Number(file.size));
      }
      destinations.push({ name, presetId, sizes, plan: planDestinationImport(folders, entries, presetId, createRecordingHistoryId) });
    }

    const plan: DriveSyncPlan = { moves: [], notInLibrary: [], missing: [], durations: 0, leftAlone: [] };
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    for (const { name: destination, plan: found } of destinations) {
      for (const link of found.relink) {
        plan.moves.push({ historyId: link.historyId, name: byId.get(link.historyId)?.name ?? link.historyId, folderName: link.folderName, destination });
      }
      for (const removed of found.removed) {
        plan.notInLibrary.push({ folderId: removed.folderId, folderName: removed.folderName, destination, kind: 'removed', name: removed.name });
      }
      for (const entry of found.create) {
        plan.notInLibrary.push({ folderId: entry.driveFolderId!, folderName: entry.driveFolderName!, destination, kind: 'new', name: entry.name });
      }
      for (const skipped of found.skipped.filter((item) => item.reason !== 'removed from the library')) {
        plan.leftAlone.push({ folder: skipped.folder, destination, reason: skipped.reason });
      }
    }
    const relinked = new Set(plan.moves.map((move) => move.historyId));
    for (const item of (await this.deps.backfill.run()).plan.backfill) {
      if (!relinked.has(item.historyId)) plan.moves.push({ historyId: item.historyId, name: item.recording, folderName: item.folderName, destination: item.destination });
    }

    const durationCandidates: Array<{ entry: RecordingHistoryEntry; fileId: string; size: number | undefined }> = [];
    const sizes = new Map(destinations.flatMap((d) => [...d.sizes]));
    for (const entry of entries.filter((candidate) => !candidate.deletedAt)) {
      const driveIds = entry.files.flatMap((file) => [file.driveFileId, ...file.locations.flatMap((l) => (l.kind === 'drive' ? [l.fileId] : []))])
        .filter((id): id is string => Boolean(id));
      if (!driveIds.length) continue;
      const unseen = driveIds.filter((id) => !seen.has(id));
      let problem: DriveSyncPlan['missing'][number]['problem'] | null = null;
      for (const id of unseen) {
        const state = await this.deps.fileState(id);
        if (state !== 'ok') problem = state === 'trashed' ? 'in the Drive trash' : 'no longer in Drive';
      }
      if (problem && unseen.length === driveIds.length) {
        plan.missing.push({ historyId: entry.id, name: entry.name, problem });
        continue;
      }
      if (entry.durationMs != null) continue;
      const media = entry.files.filter((file) => !file.kind && (file.mimeType.startsWith('video/') || file.mimeType.startsWith('audio/')));
      const lead = media.find((file) => file.stream === 'tab') ?? media[0];
      const fileId = lead?.driveFileId ?? lead?.locations.find((l) => l.kind === 'drive')?.fileId;
      if (fileId) durationCandidates.push({ entry, fileId, size: sizes.get(fileId) ?? lead!.bytes });
    }
    plan.durations = durationCandidates.length;
    return { plan, destinations, durationCandidates };
  }

  /** From the file's two ends; null when it cannot be read as WebM. */
  private async readDuration(fileId: string, size: number | undefined): Promise<number | null> {
    if (!size) return null;
    const head = await this.deps.readRange(fileId, 0, Math.min(HEAD_BYTES, size) - 1);
    if (!head) return null;
    const probed = probeWebmHead(head);
    if (probed.kind !== 'webm') return null;
    const tail = size > HEAD_BYTES ? await this.deps.readRange(fileId, Math.max(0, size - TAIL_BYTES), size - 1) : head;
    const { durationMs } = webmDurationMs(probed, tail ? probeWebmTail(tail, probed.timecodeScale) : null);
    return durationMs != null && durationMs >= 1000 && durationMs <= MAX_DURATION_MS ? durationMs : null;
  }
}
