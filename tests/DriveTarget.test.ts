import { DriveTarget } from '../src/offscreen/DriveTarget';

async function bodyToText(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  const asAny = body as any;
  if (typeof asAny?.text === 'function') return asAny.text();
  if (typeof asAny?.arrayBuffer === 'function') {
    const ab = await asAny.arrayBuffer();
    return new TextDecoder().decode(ab);
  }
  if (typeof FileReader !== 'undefined' && typeof asAny?.size === 'number' && typeof asAny?.slice === 'function') {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.readAsText(asAny as Blob);
    });
  }
  return String(body ?? '');
}

describe('DriveTarget', () => {
  let target: DriveTarget;
  let mockGetToken: jest.Mock;
  let mockOnDone: jest.Mock;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockGetToken = jest.fn().mockResolvedValue('fake-token');
    mockOnDone = jest.fn();
    mockFetch = jest.fn();
    global.fetch = mockFetch;

    target = new DriveTarget('test.webm', mockGetToken, mockOnDone);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('initializes a Drive session and uploads a finished file', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ Location: 'https://googleapis.com/upload/session-uri' }),
    });
    mockFetch.mockResolvedValueOnce({
      status: 200,
    });

    await target.upload(new Blob(['1234'], { type: 'video/webm' }));

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockGetToken).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true'
    );
    expect(mockFetch.mock.calls[1][1].headers['Content-Range']).toBe('bytes 0-3/4');
    expect(mockOnDone).toHaveBeenCalledWith('test.webm');
  });

  it('uploads large files in sequential 2MB chunks', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ Location: 'https://session-uri' }),
    });
    mockFetch
      .mockResolvedValueOnce({ status: 308 })
      .mockResolvedValueOnce({ status: 308 })
      .mockResolvedValueOnce({ status: 200 });

    const bigFile = new Blob([new ArrayBuffer(5 * 1024 * 1024)]);
    await target.upload(bigFile);

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockGetToken).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[1][1].headers['Content-Range']).toBe(`bytes 0-${2 * 1024 * 1024 - 1}/${bigFile.size}`);
    expect(mockFetch.mock.calls[2][1].headers['Content-Range']).toBe(`bytes ${2 * 1024 * 1024}-${4 * 1024 * 1024 - 1}/${bigFile.size}`);
    expect(mockFetch.mock.calls[3][1].headers['Content-Range']).toBe(`bytes ${4 * 1024 * 1024}-${bigFile.size - 1}/${bigFile.size}`);
  });

  it('refreshes the cached token when Google rejects the current one', async () => {
    mockGetToken
      .mockResolvedValueOnce('stale-token')
      .mockResolvedValueOnce('fresh-token');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ Location: 'https://session-uri' }),
    });
    mockFetch
      .mockResolvedValueOnce({ status: 401 })
      .mockResolvedValueOnce({ status: 200 });

    await target.upload(new Blob(['1234'], { type: 'video/webm' }));

    expect(mockGetToken).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer stale-token');
    expect(mockFetch.mock.calls[2][1].headers.Authorization).toBe('Bearer fresh-token');
  });

  it('recovers from AbortError by probing committed range and slicing the retry body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ Location: 'https://session-uri' }),
    });
    mockFetch.mockRejectedValueOnce(new DOMException('signal is aborted without reason', 'AbortError'));
    mockFetch.mockResolvedValueOnce({
      status: 308,
      headers: {
        get: (key: string) => (key.toLowerCase() === 'range' ? 'bytes=0-1' : null),
      } as any,
    });
    mockFetch.mockResolvedValueOnce({ status: 200 });

    await target.upload(new Blob(['abcdef'], { type: 'video/webm' }));

    expect(mockFetch).toHaveBeenCalledTimes(4);
    const retryCall = mockFetch.mock.calls[3];
    expect(retryCall[1].headers['Content-Range']).toBe('bytes 2-5/6');
    expect(await bodyToText(retryCall[1].body)).toBe('cdef');
    expect(mockOnDone).toHaveBeenCalledWith('test.webm');
  });

  it('recovers from 503 by probing committed range and resuming from the next byte', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ Location: 'https://session-uri' }),
    });
    mockFetch.mockResolvedValueOnce({ status: 503 });
    mockFetch.mockResolvedValueOnce({
      status: 308,
      headers: {
        get: (key: string) => (key.toLowerCase() === 'range' ? 'bytes=0-2' : null),
      } as any,
    });
    mockFetch.mockResolvedValueOnce({ status: 200 });

    await target.upload(new Blob(['abcdef'], { type: 'video/webm' }));

    const retryCall = mockFetch.mock.calls[3];
    expect(retryCall[1].headers['Content-Range']).toBe('bytes 3-5/6');
    expect(await bodyToText(retryCall[1].body)).toBe('def');
  });

  it('includes Drive error details when session init fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { message: 'insufficientPermissions' } }),
      headers: new Headers(),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { message: 'insufficientPermissions' } }),
      headers: new Headers(),
    });

    await expect(target.upload(new Blob(['x']))).rejects.toThrow('insufficientPermissions');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('cannot be reused for a second upload', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ Location: 'https://session-uri' }),
    });
    mockFetch.mockResolvedValueOnce({ status: 200 });

    await target.upload(new Blob(['x']));
    await expect(target.upload(new Blob(['y']))).rejects.toThrow('already used');
  });
});
