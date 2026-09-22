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

  it('creates an upload session, sends an idempotent ranged chunk, then completes it', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ uploadId: 'upl/1', chunkSize: 4, offset: 2 }, 201))
      .mockResolvedValueOnce(mockResponse('', 204))
      .mockResolvedValueOnce(mockResponse('', 204));
    const client = new ShareServiceClient('https://share.example', { fetch: fetcher as typeof fetch });

    await expect(client.beginTrackUpload({
      shareId: 's', recordingId: 'r', trackId: 't', mimeType: 'video/webm', bytes: 10,
    })).resolves.toEqual({ uploadId: 'upl/1', chunkSize: 4, offset: 2 });
    await client.uploadTrackChunk({ uploadId: 'upl/1', offset: 4, totalBytes: 10, chunk: new Blob(['1234']) });
    await client.completeTrackUpload({ uploadId: 'upl/1', totalBytes: 10 });

    expect(fetcher.mock.calls[1][0]).toBe('https://share.example/api/share-uploads/upl%2F1/chunks/4');
    const chunkHeaders = new Headers(fetcher.mock.calls[1][1].headers);
    expect(chunkHeaders.get('content-range')).toBe('bytes 4-7/10');
    expect(fetcher.mock.calls[2][0]).toBe('https://share.example/api/share-uploads/upl%2F1/complete');
  });

  it('finalizes and revokes a share', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ shareUrl: 'https://share.example/s/q4fB9-independent-capability' }))
      .mockResolvedValueOnce(mockResponse('', 204));
    const client = new ShareServiceClient('https://share.example', { fetch: fetcher as typeof fetch });

    await expect(client.finalizeShare('owner-control-id')).resolves.toEqual({
      shareUrl: 'https://share.example/s/q4fB9-independent-capability',
    });
    await client.revokeShare('owner-control-id');

    expect(fetcher.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      ['https://share.example/api/shares/owner-control-id/finalize', 'POST'],
      ['https://share.example/api/shares/owner-control-id', 'DELETE'],
    ]);
  });

  it('lists and fetches authenticated owner shares', async () => {
    const active = {
      id: 'share-1',
      status: 'active',
      manifest: { id: 'share-1', createdAt: 1, recordings: [] },
      createdAt: 1,
      updatedAt: 3,
      finalizedAt: 2,
      shareUrl: 'https://share.example/s/viewer-capability',
    };
    const revoked = {
      id: 'share-2',
      status: 'revoked',
      manifest: { id: 'share-2', createdAt: 4, recordings: [] },
      createdAt: 4,
      updatedAt: 6,
      revokedAt: 6,
    };
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ shares: [active, revoked] }))
      .mockResolvedValueOnce(jsonResponse(active));
    const client = new ShareServiceClient('https://share.example', { fetch: fetcher as typeof fetch });

    await expect(client.listShares()).resolves.toEqual([active, revoked]);
    await expect(client.getShare('share-1')).resolves.toEqual(active);
    expect(fetcher.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      ['https://share.example/api/shares', 'GET'],
      ['https://share.example/api/shares/share-1', 'GET'],
    ]);
  });

  it('rejects malformed owner-registry responses', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse({ shares: {} }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'share-1',
        status: 'active',
        manifest: { id: 'share-1', createdAt: 1, recordings: [] },
        createdAt: 1,
        updatedAt: 2,
      }));
    const client = new ShareServiceClient('https://share.example', { fetch: fetcher as typeof fetch });

    await expect(client.listShares()).rejects.toThrow('invalid share list');
    await expect(client.getShare('share-1')).rejects.toThrow('active share without a URL');
  });

  it('fails closed on non-HTTPS or path-bearing service URLs and malformed sessions', async () => {
    expect(() => new ShareServiceClient('http://share.example')).toThrow('bare HTTPS origin');
    expect(() => new ShareServiceClient('https://share.example/api')).toThrow('bare HTTPS origin');

    const client = new ShareServiceClient('https://share.example', {
      fetch: (async () => jsonResponse({ uploadId: 'u', chunkSize: 0 }, 201)) as typeof fetch,
    });
    await expect(client.beginTrackUpload({
      shareId: 's', recordingId: 'r', trackId: 't', mimeType: 'video/webm', bytes: 10,
    })).rejects.toThrow('invalid chunk size');
  });

  it('includes bounded server error text without accepting an unexpected status', async () => {
    const client = new ShareServiceClient('https://share.example', {
      fetch: (async () => mockResponse('not authorized', 401)) as typeof fetch,
    });
    await expect(client.createShare(manifest)).rejects.toThrow('failed (401): not authorized');
  });

  it('preserves upload-session-gone status and code for resumable recovery', async () => {
    const client = new ShareServiceClient('https://share.example', {
      fetch: (async () => mockResponse('{"code":"UPLOAD_SESSION_GONE"}', 410)) as typeof fetch,
    });

    const error = await client.uploadTrackChunk({
      uploadId: 'gone',
      offset: 0,
      totalBytes: 4,
      chunk: new Blob(['1234']),
    }).then(() => undefined, (caught) => caught);

    expect(error).toBeInstanceOf(ShareServiceRequestError);
    expect(error).toMatchObject({ status: 410, code: 'UPLOAD_SESSION_GONE' });
  });
});
