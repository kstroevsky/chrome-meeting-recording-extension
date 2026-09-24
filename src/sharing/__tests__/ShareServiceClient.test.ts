import type { PublishedPlaybackManifest } from '../../shared/sharing';
import { ShareServiceClient, ShareServiceRequestError } from '../ShareServiceClient';

const manifest: PublishedPlaybackManifest = {
  id: 'share/one',
  createdAt: 1,
  recordings: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  const text = JSON.stringify(body);
  return mockResponse(text, status, async () => body);
}

function mockResponse(body = '', status = 200, json?: () => Promise<unknown>): Response {
  return {
    status,
    text: async () => body,
    json: json ?? (async () => JSON.parse(body)),
  } as Response;
}

describe('ShareServiceClient', () => {
  it('creates a draft with the caller-owned share id and auth headers', async () => {
    const fetcher = jest.fn(async () => mockResponse('', 201));
    const client = new ShareServiceClient('https://share.example/', {
      fetch: fetcher as typeof fetch,
      headers: async () => ({ Authorization: 'Bearer owner-token' }),
    });

    await client.createShare(manifest);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = (fetcher as jest.Mock).mock.calls[0] as [RequestInfo | URL, RequestInit];
    expect(url).toBe('https://share.example/api/shares/share%2Fone');
    expect(init.method).toBe('PUT');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer owner-token');
    expect(JSON.parse(String(init.body))).toEqual(manifest);
  });

  it('refreshes owner authentication once after a 401', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(mockResponse('{"code":"OWNER_AUTH_INVALID"}', 401))
      .mockResolvedValueOnce(mockResponse('', 201));
    const headers = jest.fn(async (options?: { refresh?: boolean }) => ({
      Authorization: options?.refresh ? 'Bearer refreshed-token' : 'Bearer stale-token',
    }));
    const client = new ShareServiceClient('https://share.example', {
      fetch: fetcher as typeof fetch,
      headers,
    });

    await client.createShare(manifest);

    expect(headers).toHaveBeenNthCalledWith(1, undefined);
    expect(headers).toHaveBeenNthCalledWith(2, { refresh: true });
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('authorization')).toBe('Bearer stale-token');
    expect(new Headers(fetcher.mock.calls[1][1].headers).get('authorization')).toBe('Bearer refreshed-token');
  });

  it('reads the relay identity and registers an immutable private Drive origin', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ email: 'reader@example.iam.gserviceaccount.com' }))
      .mockResolvedValueOnce(mockResponse('', 201));
    const client = new ShareServiceClient('https://share.example', { fetch: fetcher as typeof fetch });

    await expect(client.getDriveReaderIdentity()).resolves.toEqual({
      email: 'reader@example.iam.gserviceaccount.com',
    });
    await client.registerDriveOrigin({
      shareId: 's/1',
      recordingId: 'r/1',
      trackId: 't/1',
      fileId: 'private-drive-file',
      revisionId: 'private-revision',
      bytes: 10,
      mimeType: 'video/webm',
      md5Checksum: 'checksum',
      permissionId: 'private-permission',
    });

    expect(fetcher.mock.calls[0][0]).toBe('https://share.example/api/sharing-reader');
    expect(fetcher.mock.calls[0][1].method).toBe('GET');
    expect(fetcher.mock.calls[1][0]).toBe(
      'https://share.example/api/shares/s%2F1/recordings/r%2F1/tracks/t%2F1/origin',
    );
    expect(fetcher.mock.calls[1][1].method).toBe('PUT');
    expect(JSON.parse(String(fetcher.mock.calls[1][1].body))).toEqual({
      fileId: 'private-drive-file',
      revisionId: 'private-revision',
      bytes: 10,
      mimeType: 'video/webm',
      md5Checksum: 'checksum',
      permissionId: 'private-permission',
    });
  });

  it('reads owner-only Drive cleanup descriptors and treats an already-deleted share as empty', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        origins: [{
          fileId: 'private-drive-file',
          revisionId: 'private-revision',
          permissionId: 'private-permission',
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({ code: 'SHARE_NOT_FOUND' }, 404));
    const client = new ShareServiceClient('https://share.example', { fetch: fetcher as typeof fetch });

    await expect(client.getShareDriveOrigins('share/one')).resolves.toEqual([{
      fileId: 'private-drive-file',
      revisionId: 'private-revision',
      permissionId: 'private-permission',
    }]);
    await expect(client.getShareDriveOrigins('gone')).resolves.toEqual([]);
    expect(fetcher.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      ['https://share.example/api/shares/share%2Fone/origins', 'GET'],
      ['https://share.example/api/shares/gone/origins', 'GET'],
    ]);
  });

  it('finalizes, revokes, and permanently deletes a share through distinct operations', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ shareUrl: 'https://share.example/s/q4fB9-independent-capability' }))
      .mockResolvedValueOnce(mockResponse('', 204))
      .mockResolvedValueOnce(mockResponse('', 204));
    const client = new ShareServiceClient('https://share.example', { fetch: fetcher as typeof fetch });

    await expect(client.finalizeShare('owner-control-id')).resolves.toEqual({
      shareUrl: 'https://share.example/s/q4fB9-independent-capability',
    });
    await client.revokeShare('owner-control-id');
    await client.deleteShare('owner-control-id');

    expect(fetcher.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      ['https://share.example/api/shares/owner-control-id/finalize', 'POST'],
      ['https://share.example/api/shares/owner-control-id/revoke', 'POST'],
      ['https://share.example/api/shares/owner-control-id', 'DELETE'],
    ]);
  });

  it('lists and fetches authenticated owner shares', async () => {
    const activeSummary = {
      id: 'share-1',
      status: 'active',
      recordingTitles: ['Customer call'],
      recordingCount: 1,
      trackCount: 2,
      totalBytes: 42,
      createdAt: 1,
      updatedAt: 3,
      finalizedAt: 2,
      shareUrl: 'https://share.example/s/viewer-capability',
    };
    const revokedSummary = {
      id: 'share-2',
      status: 'revoked',
      recordingTitles: ['Second call'],
      recordingCount: 1,
      trackCount: 1,
      createdAt: 4,
      updatedAt: 6,
      revokedAt: 6,
    };
    const active = {
      ...activeSummary,
      manifest: { id: 'share-1', createdAt: 1, recordings: [] },
    };
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ shares: [activeSummary], nextCursor: '1' }))
      .mockResolvedValueOnce(jsonResponse({ shares: [revokedSummary] }))
      .mockResolvedValueOnce(jsonResponse(active));
    const client = new ShareServiceClient('https://share.example', { fetch: fetcher as typeof fetch });

    await expect(client.listShares()).resolves.toEqual([activeSummary, revokedSummary]);
    await expect(client.getShare('share-1')).resolves.toEqual(active);
    expect(fetcher.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      ['https://share.example/api/shares?limit=50', 'GET'],
      ['https://share.example/api/shares?limit=50&cursor=1', 'GET'],
      ['https://share.example/api/shares/share-1', 'GET'],
    ]);
  });

  it('rejects malformed owner-registry responses', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ shares: {} }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'share-1',
        status: 'active',
        recordingTitles: [],
        recordingCount: 0,
        trackCount: 0,
        manifest: { id: 'share-1', createdAt: 1, recordings: [] },
        createdAt: 1,
        updatedAt: 2,
      }));
    const client = new ShareServiceClient('https://share.example', { fetch: fetcher as typeof fetch });

    await expect(client.listShares()).rejects.toThrow('invalid share list');
    await expect(client.getShare('share-1')).rejects.toThrow('active share without a URL');
  });

  it('retries a permanent delete once when the server completed it but the response was lost', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(mockResponse('{"code":"E2E_LOST_RESPONSE"}', 503))
      .mockResolvedValueOnce(mockResponse('', 204));
    const client = new ShareServiceClient('https://share.example', { fetch: fetcher as typeof fetch });

    await expect(client.deleteShare('share-1')).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('fails closed on non-HTTPS or path-bearing service URLs and malformed relay identity', async () => {
    expect(() => new ShareServiceClient('http://share.example')).toThrow('bare HTTPS origin');
    expect(() => new ShareServiceClient('https://share.example/api')).toThrow('bare HTTPS origin');

    const client = new ShareServiceClient('https://share.example', {
      fetch: (async () => jsonResponse({ email: '' })) as typeof fetch,
    });
    await expect(client.getDriveReaderIdentity()).rejects.toThrow('no Drive reader identity');
  });

  it('includes bounded server error text without accepting an unexpected status', async () => {
    const client = new ShareServiceClient('https://share.example', {
      fetch: (async () => mockResponse('not authorized', 401)) as typeof fetch,
    });
    await expect(client.createShare(manifest)).rejects.toThrow('failed (401): not authorized');
  });

  it('preserves Drive-origin conflict status and code for deterministic recovery', async () => {
    const client = new ShareServiceClient('https://share.example', {
      fetch: (async () => mockResponse('{"code":"DRIVE_ORIGIN_CONFLICT"}', 409)) as typeof fetch,
    });

    const error = await client.registerDriveOrigin({
      shareId: 's',
      recordingId: 'r',
      trackId: 't',
      fileId: 'f',
      revisionId: 'rev',
      bytes: 4,
      mimeType: 'video/webm',
    }).then(() => undefined, (caught) => caught);

    expect(error).toBeInstanceOf(ShareServiceRequestError);
    expect(error).toMatchObject({ status: 409, code: 'DRIVE_ORIGIN_CONFLICT' });
  });
});
