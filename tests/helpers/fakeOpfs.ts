/**
 * In-memory OPFS double for unit tests.
 *
 * Outside `src/` on purpose: `collectCoverageFrom` sweeps `src/**` and excludes
 * only `*.test.ts`, so a helper there would be reported as untested production
 * code.
 *
 * Models the parts `opfsLayout` and `RetainedMediaStore` rely on, including the
 * behaviour that actually bit us on a shipping browser: `move()` can be
 * *present* and throw `NotAllowedError` when called (Edge 118, measured in
 * `tests/spikes/opfs-move-spike.mjs`). `moveMode` reproduces all three states.
 */

import type { DirectoryHandleLike, FileHandleLike } from '../../src/offscreen/storage/opfsLayout';

export type MoveMode = 'works' | 'throws' | 'absent';

type Entry = { bytes: Uint8Array; lastModified: number };

export type FakeOpfs = {
  root: DirectoryHandleLike;
  /** Every file path -> byte length, for compact assertions. */
  snapshot(): Record<string, number>;
  seed(path: string, size: number, lastModified?: number): void;
  read(path: string): Uint8Array | undefined;
  moveCalls: number;
};

class NotFoundError extends Error {
  constructor(name: string) { super(`NotFoundError: ${name}`); this.name = 'NotFoundError'; }
}

export function createFakeOpfs(moveMode: MoveMode = 'works'): FakeOpfs {
  const files = new Map<string, Entry>();
  const dirs = new Set<string>();
  const state = { moveCalls: 0 };

  const join = (prefix: string, name: string) => (prefix ? `${prefix}/${name}` : name);

  const makeFile = (path: string): FileHandleLike => {
    const handle: FileHandleLike = {
      async getFile() {
        const entry = files.get(path);
        if (!entry) throw new NotFoundError(path);
        return {
          size: entry.bytes.length,
          lastModified: entry.lastModified,
          stream: () => new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(entry.bytes); controller.close(); },
          }),
        } as unknown as File;
      },
      async createWritable() {
        const chunks: Uint8Array[] = [];
        const commit = () => {
          const total = chunks.reduce((n, c) => n + c.length, 0);
          const bytes = new Uint8Array(total);
          let at = 0;
          for (const c of chunks) { bytes.set(c, at); at += c.length; }
          files.set(path, { bytes, lastModified: Date.now() });
        };
        const push = (data: unknown) => {
          if (data instanceof Uint8Array) chunks.push(data);
          else if (data && typeof data === 'object' && 'size' in (data as { size?: number })) {
            chunks.push(new Uint8Array((data as { size: number }).size));
          }
        };
        const writable = new WritableStream<Uint8Array>({
          write(chunk) { push(chunk); },
          close() { commit(); },
        }) as unknown as { write(d: unknown): Promise<void>; close(): Promise<void> };
        writable.write = async (data: unknown) => { push(data); };
        writable.close = async () => { commit(); };
        return writable;
      },
    };
    if (moveMode !== 'absent') {
      handle.move = async (destination: DirectoryHandleLike, name: string) => {
        state.moveCalls += 1;
        if (moveMode === 'throws') {
          const error = new Error('The request is not allowed by the user agent or the platform in the current context.');
          error.name = 'NotAllowedError';
          throw error;
        }
        const entry = files.get(path);
        if (!entry) throw new NotFoundError(path);
        files.delete(path);
        files.set(join((destination as unknown as { __path: string }).__path, name), entry);
      };
    }
    return handle;
  };

  const makeDir = (prefix: string): DirectoryHandleLike => ({
    __path: prefix,
    async getDirectoryHandle(name, options) {
      const path = join(prefix, name);
      if (!dirs.has(path)) {
        if (!options?.create) throw new NotFoundError(path);
        dirs.add(path);
      }
      return makeDir(path);
    },
    async getFileHandle(name, options) {
      const path = join(prefix, name);
      if (!files.has(path)) {
        if (!options?.create) throw new NotFoundError(path);
        files.set(path, { bytes: new Uint8Array(0), lastModified: Date.now() });
      }
      return makeFile(path);
    },
    async removeEntry(name) {
      const path = join(prefix, name);
      if (!files.delete(path) && !dirs.delete(path)) throw new NotFoundError(path);
    },
    keys() {
      const depth = prefix ? prefix.split('/').length : 0;
      const names = new Set<string>();
      for (const path of [...files.keys(), ...dirs]) {
        if (prefix && !path.startsWith(`${prefix}/`)) continue;
        const segments = path.split('/');
        if (segments.length !== depth + 1) continue;
        names.add(segments[depth]);
      }
      return (async function* () { for (const name of names) yield name; })();
    },
  } as DirectoryHandleLike & { __path: string });

  return {
    root: makeDir(''),
    snapshot: () => Object.fromEntries([...files].map(([path, entry]) => [path, entry.bytes.length])),
    seed(path, size, lastModified = 0) {
      const segments = path.split('/');
      for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join('/'));
      files.set(path, { bytes: new Uint8Array(size).fill(7), lastModified });
    },
    read: (path) => files.get(path)?.bytes,
    get moveCalls() { return state.moveCalls; },
  };
}
