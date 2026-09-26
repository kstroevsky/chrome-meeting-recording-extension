/**
 * @file shared/driveSync.ts
 *
 * The contract of "Sync with Drive" between the Recordings page and the
 * background: a preview of what differs, the user's choice from it, and what
 * was done. See `background/drive/DriveLibrarySync.ts`.
 */

export type DriveSyncPlan = {
  /** Entries whose folder moved or was re-filed in Drive (or had none recorded). */
  moves: Array<{ historyId: string; name: string; folderName: string; destination: string }>;
  /** Recording folders the library lacks: removed by the user, or never imported. */
  notInLibrary: Array<{ folderId: string; folderName: string; destination: string; kind: 'removed' | 'new'; name: string }>;
  /** Entries whose Drive files are gone. Reported only. */
  missing: Array<{ historyId: string; name: string; problem: 'in the Drive trash' | 'no longer in Drive' }>;
  /** How many entries have no duration and a Drive file to read it from. */
  durations: number;
  /** Folders sync cannot read as one recording, and why. */
  leftAlone: Array<{ folder: string; destination: string; reason: string }>;
};

/** What the user chose from the preview. `bringBack` holds folder ids. */
export type DriveSyncChoice = { moves: boolean; durations: boolean; bringBack: string[] };

export type DriveSyncResult = { moved: number; broughtBack: number; durations: number; durationsUnreadable: number };

/** A choice as it arrives over a message boundary, made safe to act on. */
export function normalizeDriveSyncChoice(value: unknown): DriveSyncChoice {
  const candidate = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const bringBack = Array.isArray(candidate.bringBack)
    ? candidate.bringBack.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 200).slice(0, 1000)
    : [];
  return { moves: candidate.moves === true, durations: candidate.durations === true, bringBack };
}
