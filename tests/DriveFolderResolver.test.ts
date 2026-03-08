import { DriveFolderResolver } from '../src/offscreen/drive/DriveFolderResolver';

function jsonResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('DriveFolderResolver', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('shares one in-flight folder resolution across concurrent callers', async () => {
    const getToken = jest.fn().mockResolvedValue('token');
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'root-folder' }))
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'recording-folder' }));

    const resolver = new DriveFolderResolver(getToken);
    const hierarchy = {
      rootFolderName: 'Root Folder Concurrent',
      recordingFolderName: 'Recording Concurrent',
    };

    const [first, second] = await Promise.all([
      resolver.resolveUploadParentId(hierarchy),
      resolver.resolveUploadParentId(hierarchy),
    ]);

    expect(first).toBe('recording-folder');
    expect(second).toBe('recording-folder');
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it('evicts a rejected recording-folder cache entry so the next attempt can retry', async () => {
    const getToken = jest.fn().mockResolvedValue('token');
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ files: [{ id: 'root-folder' }] }))
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => JSON.stringify({ error: { message: 'backendError' } }),
      })
      .mockResolvedValueOnce(jsonResponse({ files: [{ id: 'root-folder' }] }))
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'recording-folder' }));

    const resolver = new DriveFolderResolver(getToken);
    const hierarchy = {
      rootFolderName: 'Root Folder Retry',
      recordingFolderName: 'Recording Retry',
    };

    await expect(resolver.resolveUploadParentId(hierarchy)).rejects.toThrow('backendError');
    await expect(resolver.resolveUploadParentId(hierarchy)).resolves.toBe('recording-folder');
    expect(global.fetch).toHaveBeenCalledTimes(6);
  });
});
