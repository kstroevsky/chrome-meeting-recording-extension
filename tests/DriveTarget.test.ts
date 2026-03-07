import { DriveTarget } from '../src/offscreen/DriveTarget';

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

  it('initializes session on first write', async () => {
    // Mock the session creation fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ Location: 'https://googleapis.com/upload/session-uri' })
    });

    const chunk = new Blob(['123'], { type: 'video/webm' });
    await target.write(chunk);

    expect(mockGetToken).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    
    // Verify the HTTP request structure
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[0]).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true');
    expect(fetchCall[1].method).toBe('POST');
    expect(fetchCall[1].headers.Authorization).toBe('Bearer fake-token');
    expect(JSON.parse(fetchCall[1].body)).toEqual({ name: 'test.webm', mimeType: 'video/webm' });
  });

  it('flushes when threshold is reached and rotates token', async () => {
    // 1. Session creation response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ Location: 'https://googleapis.com/upload/session-uri' })
    });

    // 2. Chunk upload response (308 Resume Incomplete)
    mockFetch.mockResolvedValueOnce({
      status: 308,
    });

    // Create a 5MB blob to force a flush
    const bigChunk = new Blob([new ArrayBuffer(5 * 1024 * 1024)]);
    await target.write(bigChunk);

    // Initial session + flush token
    expect(mockGetToken).toHaveBeenCalledTimes(2);

    // Verify the flush request
    const flushCall = mockFetch.mock.calls[1];
    expect(flushCall[0]).toBe('https://googleapis.com/upload/session-uri');
    expect(flushCall[1].method).toBe('PUT');
    expect(flushCall[1].headers['Content-Range']).toBe('bytes 0-5242879/*');
  });

  it('notifies onDone when closed', async () => {
    // Session setup
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ Location: 'https://googleapis.com/upload/session-uri' })
    });
    // Final chunk response
    mockFetch.mockResolvedValueOnce({
      status: 200,
    });

    await target.write(new Blob(['data']));
    await target.close();

    // Verify final flush is correctly marked
    const finalFlushCall = mockFetch.mock.calls[1];
    expect(finalFlushCall[1].headers['Content-Range']).toBe(`bytes 0-3/4`);

    expect(mockOnDone).toHaveBeenCalledWith('test.webm');
  });

  it('recovers from a 503 error by querying committed offset', async () => {
    // 1. Session setup
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ Location: 'https://session-uri' })
    });

    // 2. Failed chunk upload (simulated network drop)
    mockFetch.mockResolvedValueOnce({
      status: 503,
    });

    // 3. Status query to check what Drive received
    mockFetch.mockResolvedValueOnce({
      status: 308,
      headers: new Headers({ Range: 'bytes=0-0' }) // Drive only got 1 byte
    });

    // 4. Retry upload succeeds
    mockFetch.mockResolvedValueOnce({
      status: 200, // Finish
    });

    await target.write(new Blob(['abcdefg']));
    await target.close();

    expect(mockFetch).toHaveBeenCalledTimes(4); // Init + Fail + Query + Retry
    expect(mockOnDone).toHaveBeenCalled();
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

    await expect(target.write(new Blob(['x']))).rejects.toThrow('insufficientPermissions');
    expect(mockFetch).toHaveBeenCalledTimes(2); // retried once for auth-related failure
  });

  it('creates missing root + recording folders and uploads into recording folder', async () => {
    const targetWithFolders = new DriveTarget('test.webm', mockGetToken, mockOnDone, {
      rootFolderName: 'Google Meet Records',
      recordingFolderName: 'abc-defg-hij-1712088000000',
    });

    // root lookup -> not found
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [] }),
    });
    // root create
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'root-folder-id' }),
    });
    // recording lookup -> not found
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ files: [] }),
    });
    // recording create
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'recording-folder-id' }),
    });
    // upload session init
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ Location: 'https://googleapis.com/upload/session-uri' }),
    });

    await targetWithFolders.write(new Blob(['1']));

    const uploadCall = mockFetch.mock.calls[4];
    expect(uploadCall[0]).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true');
    expect(JSON.parse(uploadCall[1].body)).toEqual({
      name: 'test.webm',
      mimeType: 'video/webm',
      parents: ['recording-folder-id'],
    });
  });
});
