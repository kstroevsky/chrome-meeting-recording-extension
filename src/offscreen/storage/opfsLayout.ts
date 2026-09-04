/**
 * @file offscreen/storage/opfsLayout.ts
 *
 * The OPFS namespace, after ADR-0006 split it in two:
 *
 *   staging/   capture, sealing, delivery, crash recovery — transient by design
 *   library/   media the extension intentionally retains for the player
 *
 * Everything addresses files by an **OPFS key**: a `/`-separated path relative
 * to the OPFS root. One property carries the whole legacy migration: a key with
 * no separator is a *pre-split root file*. Recordings orphaned before the
 * upgrade, and pending-upload markers written before it, hold bare filenames and
 * therefore keep resolving at the root with no version flag, no marker, and no
 * migration pass. New writes always carry a directory, so the two can never be
 * confused, and the legacy arm retires itself once the last root file drains.
 */

export const STAGING_DIR = 'staging';
export const LIBRARY_DIR = 'library';

/** A `/`-separated OPFS path relative to the root. */
export type OpfsKey = string;

/** True for a pre-ADR-0006 key: a bare filename living at the OPFS root. */
export function isLegacyRootKey(key: OpfsKey): boolean {
  return !key.includes('/');
}

export function keySegments(key: OpfsKey): string[] {
  return key.split('/').filter(Boolean);
}

/** The display filename is the last segment; callers still show it to users. */
export function filenameFromKey(key: OpfsKey): string {
  const segments = keySegments(key);
  return segments[segments.length - 1] ?? key;
}

export function stagingKey(filename: string): OpfsKey {
  return `${STAGING_DIR}/${filename}`;
}

/** Segments must survive as OPFS names, so anything path-like is percent-encoded. */
function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function extensionOf(filename: string): string {
  const match = /(\.[A-Za-z0-9]+)$/.exec(filename);
  return match ? match[1] : '.webm';
}

/**
 * Deterministic, so a promotion interrupted by a crash re-runs onto the same
 * destination instead of creating a second copy (ADR-0006).
 */
export function libraryKey(historyId: string, fileId: string, filename: string): OpfsKey {
  return `${LIBRARY_DIR}/${encodeSegment(historyId)}/${encodeSegment(fileId)}${extensionOf(filename)}`;
}

/** Minimal structural view of the OPFS handles this module needs. */
export type DirectoryHandleLike = {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterable<string>;
};

export type FileHandleLike = {
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: unknown): Promise<void>; close(): Promise<void> }>;
  move?: (destination: DirectoryHandleLike, name: string) => Promise<void>;
};

/** Walks to the directory holding `key`, creating intermediate levels on request. */
export async function directoryForKey(
  root: DirectoryHandleLike,
  key: OpfsKey,
  options?: { create?: boolean },
): Promise<DirectoryHandleLike> {
  const segments = keySegments(key);
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment, { create: options?.create === true });
  }
  return dir;
}

export async function fileHandleForKey(
  root: DirectoryHandleLike,
  key: OpfsKey,
  options?: { create?: boolean },
): Promise<FileHandleLike> {
  const dir = await directoryForKey(root, key, options);
  return await dir.getFileHandle(filenameFromKey(key), { create: options?.create === true });
}

/** Reads a key, or null when it is missing or unreadable. */
export async function readFileByKey(root: DirectoryHandleLike, key: OpfsKey): Promise<File | null> {
  try {
    return await (await fileHandleForKey(root, key)).getFile();
  } catch {
    return null;
  }
}

export async function existsByKey(root: DirectoryHandleLike, key: OpfsKey): Promise<boolean> {
  return (await readFileByKey(root, key)) != null;
}

/** Deletes a key. Missing is success — deletion is the desired end state. */
export async function removeByKey(root: DirectoryHandleLike, key: OpfsKey): Promise<void> {
  try {
    const dir = await directoryForKey(root, key);
    await dir.removeEntry(filenameFromKey(key));
  } catch {
    /* already gone */
  }
}

export type OpfsEntry = { key: OpfsKey; name: string; lastModifiedMs: number };

/**
 * Lists the files directly inside one directory. `prefix` is '' for the root.
 * Directory entries are skipped, which is what keeps a root listing from
 * descending into `staging/` or `library/` — the invariant ADR-0006 exists to
 * protect is that orphan recovery must never see the library.
 */
export async function listFiles(root: DirectoryHandleLike, prefix: OpfsKey | ''): Promise<OpfsEntry[]> {
  const entries: OpfsEntry[] = [];
  let dir: DirectoryHandleLike;
  try {
    dir = prefix ? await directoryForKey(root, `${prefix}/x`) : root;
  } catch {
    return entries; // the directory does not exist yet
  }
  try {
    for await (const name of dir.keys()) {
      try {
        const file = await (await dir.getFileHandle(name)).getFile();
        entries.push({ key: prefix ? `${prefix}/${name}` : name, name, lastModifiedMs: file.lastModified });
      } catch {
        // A directory entry, or a file locked by an active sync-access handle.
      }
    }
  } catch {
    /* OPFS unavailable */
  }
  return entries;
}
