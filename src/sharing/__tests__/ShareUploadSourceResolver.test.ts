import type { PlaybackTrack } from '../../shared/playback';
import type { DirectoryHandleLike } from '../../offscreen/storage/opfsLayout';
import { createShareUploadSourceResolver } from '../ShareUploadSourceResolver';

async function blobToText(blob: Blob): Promise<string> {
  const value = blob as Blob & { text?: () => Promise<string>; arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof value.text === 'function') return await value.text();
  if (typeof value.arrayBuffer === 'function') return new TextDecoder().decode(await value.arrayBuffer());
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(blob);
  });
}

function response(status: number, body: Blob = new Blob(), headers: HeadersInit = {}): Response {
  return {
    status,
    headers: new Headers(headers),
    blob: async () => body,
  } as Response;
}

function track(sources: PlaybackTrack['sources'], bytes?: number): PlaybackTrack {
  return {
    fileId: 'private-file',
    stream: 'tab',
    filename: 'tab.webm',
    mimeType: 'video/webm',
    ...(bytes != null ? { bytes } : {}),
    captureStartOffsetMs: 0,
    sources,
  };
}

function rootWithFile(key: string, blob: Blob): DirectoryHandleLike {
  const parts = key.split('/');
  const walk = (depth: number): DirectoryHandleLike => ({
    async getDirectoryHandle(name) {
      if (name !== parts[depth]) throw new Error('missing');
      return walk(depth + 1);
    },
    async getFileHandle(name) {
      if (depth !== parts.length - 1 || name !== parts[depth]) throw new Error('missing');
      return { getFile: async () => blob as File, createWritable: async () => { throw new Error('unused'); } };
    },
    async removeEntry() {},
  });
  return walk(0);
}

describe('createShareUploadSourceResolver', () => {
  it('prefers OPFS and exposes random-access Blob slices', async () => {
    const blob = new Blob(['0123456789'], { type: 'video/webm' });
    const fetcher = jest.fn();
    const resolver = createShareUploadSourceResolver({
      getRoot: async () => rootWithFile('library/r1/tab.webm', blob),
      getDriveToken: async () => 'drive-token',
      fetch: fetcher as typeof fetch,
    });

    const source = await resolver(track([
      { kind: 'opfs', key: 'library/r1/tab.webm' },
      { kind: 'drive', fileId: 'drive-id' },
    ], 10));

    expect(source.size).toBe(10);
    expect(await blobToText(await source.read(3, 7))).toBe('3456');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('falls through a stale OPFS location and reads Drive by byte range', async () => {
    const fetcher = jest.fn(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer drive-token');
      expect(headers.Range).toBe('bytes=4-7');
      return response(206, new Blob(['4567']), { 'content-range': 'bytes 4-7/10' });
    });
    const missingRoot = rootWithFile('somewhere/else.webm', new Blob());
    const resolver = createShareUploadSourceResolver({
      getRoot: async () => missingRoot,
      getDriveToken: async () => 'drive-token',
      fetch: fetcher as typeof fetch,
    });

    const source = await resolver(track([
      { kind: 'opfs', key: 'library/r1/tab.webm' },
      { kind: 'drive', fileId: 'drive/id' },
    ], 10));
    expect(await blobToText(await source.read(4, 8))).toBe('4567');
    expect(fetcher.mock.calls[0][0]).toBe('https://www.googleapis.com/drive/v3/files/drive%2Fid?alt=media');
  });

  it('refreshes Drive auth once and can discover the size for legacy tracks', async () => {
    const tokens: string[] = [];
    const getDriveToken = jest.fn(async (options?: { refresh?: boolean }) => {
      const token = options?.refresh ? 'fresh' : 'stale';
      tokens.push(token);
      return token;
    });
    const fetcher = jest.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === 'Bearer stale') return response(401);
      return response(206, new Blob(['x']), { 'content-range': 'bytes 0-0/123' });
    });
    const resolver = createShareUploadSourceResolver({ getDriveToken, fetch: fetcher as typeof fetch });

    const source = await resolver(track([{ kind: 'drive', fileId: 'd1' }]));

    expect(source.size).toBe(123);
    expect(tokens).toEqual(['stale', 'fresh']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects Downloads-only tracks instead of pretending their bytes are reachable', async () => {
    const resolver = createShareUploadSourceResolver();
    await expect(resolver(track([{ kind: 'download', downloadId: 7, playableInExtension: false }], 10)))
      .rejects.toThrow('downloaded files cannot be read');
  });
});
