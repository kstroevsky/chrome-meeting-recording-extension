import { ExternalMediaClient, MediaHttpError } from '../ExternalMediaClient';
import type { MediaCapability } from '../MediaCapability';

const uploadId = `upload_${'b'.repeat(8)}-${'b'.repeat(4)}-4bbb-8bbb-${'b'.repeat(12)}`;
const capability: MediaCapability = {
  version: 1,
  apiBase: 'https://crm.example.test/api/media',
  upload: { strategy: 'multipart-put-v1', origins: ['https://objects.example.test'] },
  playback: { strategy: 'refreshable-url-v1' },
};

function response(data: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let consumed = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (key: string) => key.toLowerCase() === 'content-length' ? String(bytes.length) : null },
    body: { getReader: () => ({
      read: async () => consumed ? { done: true } : (consumed = true, { done: false, value: bytes }),
      cancel: async () => {},
    }) },
  } as unknown as Response;
}

function signed(url = 'https://objects.example.test/media?X-Amz-Signature=opaque') {
  return response({ method: 'PUT', url, headers: { 'Content-Type': 'video/webm' } });
}

function storageResponse(status = 200): Response {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (key: string) => key.toLowerCase() === 'etag' ? '"etag-1"' : null },
  } as unknown as Response;
}

function harness(fetcher: jest.Mock, allowed = jest.fn(async () => true)) {
  return {
    client: new ExternalMediaClient(capability, 'https://crm.example.test/hooks/recordings',
      async () => 'sensitive-token', fetcher as typeof fetch, allowed),
    allowed,
  };
}

describe('ExternalMediaClient signed storage upload', () => {
  const blob = new Blob(['video'], { type: 'video/webm' });

  it('renews an opaque network/CORS failure with a new signing request and checks each origin', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(signed())
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(signed('https://objects.example.test/renewed?X-Amz-Signature=fresh'))
      .mockResolvedValueOnce(storageResponse());
    const { client, allowed } = harness(fetcher);
    await expect(client.uploadPart(uploadId, 1, blob)).resolves.toBe('"etag-1"');
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(allowed).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer sensitive-token');
    for (const index of [1, 3]) {
      expect(fetcher.mock.calls[index][1]).toMatchObject({
        method: 'PUT', credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer',
      });
      expect(fetcher.mock.calls[index][1].headers).not.toHaveProperty('Authorization');
      expect(fetcher.mock.calls[index][1].body).toBe(blob);
    }
  });

  it('refuses a refreshed signed URL with a different origin before sending any bytes', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(signed())
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(signed('https://attacker.example.test/upload'));
    const { client, allowed } = harness(fetcher);
    await expect(client.uploadPart(uploadId, 1, blob)).rejects.toThrow('Untrusted media upload URL');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(allowed).toHaveBeenCalledTimes(1);
  });

  it('requires host permission on every renewal', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(signed())
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(signed());
    const allowed = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(harness(fetcher, allowed).client.uploadPart(uploadId, 1, blob))
      .rejects.toThrow('Untrusted media upload URL');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(allowed).toHaveBeenCalledTimes(2);
  });

  it('bounds CORS-opaque retries and returns a terminal network failure', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(signed()).mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(signed()).mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(signed()).mockRejectedValueOnce(new TypeError('network'));
    await expect(harness(fetcher).client.uploadPart(uploadId, 1, blob))
      .rejects.toThrow('network');
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('does not retry aborts or non-network failures, and renews explicit 403 responses', async () => {
    const aborted = new AbortController();
    const abortFetch = jest.fn().mockResolvedValueOnce(signed()).mockImplementationOnce(async () => {
      aborted.abort();
      throw new TypeError('aborted');
    });
    await expect(harness(abortFetch).client.uploadPart(uploadId, 1, blob, aborted.signal))
      .rejects.toThrow('aborted');
    expect(abortFetch).toHaveBeenCalledTimes(2);

    const failed = jest.fn().mockResolvedValueOnce(signed()).mockRejectedValueOnce(new Error('not network'));
    await expect(harness(failed).client.uploadPart(uploadId, 1, blob)).rejects.toThrow('not network');
    expect(failed).toHaveBeenCalledTimes(2);

    const forbidden = jest.fn()
      .mockResolvedValueOnce(signed()).mockResolvedValueOnce(storageResponse(403))
      .mockResolvedValueOnce(signed()).mockResolvedValueOnce(storageResponse());
    await expect(harness(forbidden).client.uploadPart(uploadId, 1, blob)).resolves.toBe('"etag-1"');
    expect(forbidden).toHaveBeenCalledTimes(4);
  });

  it('rejects error responses on the control plane without exposing the signed URL', async () => {
    const fetcher = jest.fn().mockResolvedValue(response({ code: 'NOT_FOUND' }, 404));
    await expect(harness(fetcher).client.uploadPart(uploadId, 1, blob))
      .rejects.toEqual(new MediaHttpError(404, 'NOT_FOUND'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves only a bounded structured receiver error code for retry classification', async () => {
    const fetcher = jest.fn().mockResolvedValue(response({
      code: 'MEDIA_UPLOAD_COMPLETING',
      details: 'must not be copied into the client error',
    }, 409));
    await expect(harness(fetcher).client.status(uploadId))
      .rejects.toEqual(new MediaHttpError(409, 'MEDIA_UPLOAD_COMPLETING'));
  });
});
