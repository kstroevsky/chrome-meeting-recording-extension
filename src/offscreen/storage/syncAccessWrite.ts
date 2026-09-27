/** Minimal surface needed from FileSystemSyncAccessHandle for append writes. */
export type SyncAccessWriter = {
  write(buffer: BufferSource, options?: { at?: number }): number;
};

/**
 * Writes every byte, honoring the sync-access contract that one call may make
 * only partial progress. Zero/invalid progress is an explicit failure instead
 * of an infinite retry or a falsely acknowledged chunk.
 */
export function writeSyncFully(
  writer: SyncAccessWriter,
  bytes: Uint8Array,
  at: number,
): number {
  let written = 0;
  while (written < bytes.byteLength) {
    const remaining = bytes.subarray(written);
    const count = writer.write(remaining, { at: at + written });
    if (!Number.isInteger(count) || count <= 0 || count > remaining.byteLength) {
      throw new Error(`OPFS sync write made invalid progress (${count}/${remaining.byteLength} bytes)`);
    }
    written += count;
  }
  return written;
}
