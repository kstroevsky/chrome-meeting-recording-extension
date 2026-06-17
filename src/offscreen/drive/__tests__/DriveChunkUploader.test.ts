import {
  backoffMs,
  isTransientFetchError,
  recoverFromCommittedState,
  uploadChunk,
} from '../DriveChunkUploader';
import {
  DRIVE_MAX_RETRIES,
  DRIVE_RETRY_BACKOFF_MAX_MULTIPLIER,
  DRIVE_RETRY_BASE_DELAY_MS,
} from '../constants';
import type { TokenProvider } from '../request';

const SESSION = 'https://upload.example/session/1';
const token: TokenProvider = async () => 'tok';

function blob(size: number): Blob {
  return new Blob([new Uint8Array(size)]);
}

/**
 * Minimal Response stand-in for the fields uploadChunk/recover actually read.
 * Uses a plain `get`-based headers stub because `new Headers()` silently drops
 * the forbidden `Range` header name in this environment.
 */
function res(status: number, headers: Record<string, string> = {}): Response {
  return {
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    text: async () => JSON.stringify({ error: { message: 'mock drive error' } }),
  } as unknown as Response;
}

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('isTransientFetchError', () => {
  it('treats AbortError and TypeError (network) as transient', () => {
    expect(isTransientFetchError({ name: 'AbortError' })).toBe(true);
    expect(isTransientFetchError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('treats everything else as non-transient', () => {
    expect(isTransientFetchError(new Error('boom'))).toBe(false);
    expect(isTransientFetchError({ name: 'RangeError' })).toBe(false);
    expect(isTransientFetchError(null)).toBe(false);
  });
});

describe('backoffMs', () => {
  it('grows exponentially from the base delay', () => {
    expect(backoffMs(1)).toBe(DRIVE_RETRY_BASE_DELAY_MS);
    expect(backoffMs(2)).toBe(DRIVE_RETRY_BASE_DELAY_MS * 2);
    expect(backoffMs(3)).toBe(DRIVE_RETRY_BASE_DELAY_MS * 4);
  });

  it('caps at the max multiplier', () => {
    expect(backoffMs(50)).toBe(DRIVE_RETRY_BASE_DELAY_MS * DRIVE_RETRY_BACKOFF_MAX_MULTIPLIER);
  });
});

describe('recoverFromCommittedState', () => {
  it('reports done when Drive already finalized the file (200/201)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(res(201));
    const out = await recoverFromCommittedState(SESSION, 'tok', 0, blob(100), 100);
    expect(out.done).toBe(true);
    expect(out.start).toBe(100);
    expect(out.body.size).toBe(0);
  });

  it('resumes from the committed offset in the Range header', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(res(308, { Range: 'bytes=0-49' }));
    const out = await recoverFromCommittedState(SESSION, 'tok', 0, blob(100), 100);
    expect(out.done).toBe(false);
    expect(out.start).toBe(50);
    expect(out.body.size).toBe(50); // body.slice(50)
  });

  it('reports done when the committed range already covers this chunk', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(res(308, { Range: 'bytes=0-99' }));
    const out = await recoverFromCommittedState(SESSION, 'tok', 0, blob(100), 100);
    expect(out.done).toBe(true);
    expect(out.start).toBe(100);
  });

  it('leaves the chunk unchanged when no Range header is returned', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(res(308));
    const body = blob(100);
    const out = await recoverFromCommittedState(SESSION, 'tok', 0, body, 100);
    expect(out).toEqual({ done: false, start: 0, body });
  });

  it('leaves the chunk unchanged when the probe itself fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new TypeError('offline'));
    const body = blob(100);
    const out = await recoverFromCommittedState(SESSION, 'tok', 0, body, 100);
    expect(out).toEqual({ done: false, start: 0, body });
  });
});

describe('uploadChunk', () => {
  it('advances the offset on an intermediate 308', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(res(308));
    const result = await uploadChunk(SESSION, token, 0, blob(2048), 4096, false);
    expect(result.nextStart).toBe(2048);
    expect(result.attempts).toBe(1);
    expect(result.hadRetry).toBe(false);
    expect(result.status).toBe(308);
  });

  it('completes on a final 200', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(res(200));
    const result = await uploadChunk(SESSION, token, 2048, blob(2048), 4096, true);
    expect(result.nextStart).toBe(4096);
    expect(result.status).toBe(200);
  });

  it('retries after a transient network error, then succeeds', async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock)
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // PUT attempt 1
      .mockResolvedValueOnce(res(308))                          // recovery probe (no range)
      .mockResolvedValueOnce(res(200));                         // PUT attempt 2 (final)

    const p = uploadChunk(SESSION, token, 0, blob(100), 100, true);
    await jest.advanceTimersByTimeAsync(DRIVE_RETRY_BASE_DELAY_MS * 2);
    const result = await p;

    expect(result.status).toBe(200);
    expect(result.hadRetry).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('retries on a 5xx and resumes from the recovered committed offset', async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(res(503))                         // PUT attempt 1
      .mockResolvedValueOnce(res(308, { Range: 'bytes=0-49' })) // recovery probe
      .mockResolvedValueOnce(res(200));                        // PUT attempt 2

    const p = uploadChunk(SESSION, token, 0, blob(100), 100, true);
    await jest.advanceTimersByTimeAsync(DRIVE_RETRY_BASE_DELAY_MS * 2);
    const result = await p;

    expect(result.status).toBe(200);
    expect(result.hadRetry).toBe(true);
  });

  it('refreshes the token on a 401 and retries (no backoff)', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200));
    const refreshable = jest.fn<Promise<string>, [{ refresh?: boolean }?]>(async () => 'tok');

    const result = await uploadChunk(SESSION, refreshable, 0, blob(100), 100, true);

    expect(result.status).toBe(200);
    expect(refreshable).toHaveBeenCalledWith({ refresh: true });
  });

  it('throws after exhausting retries on a persistent 5xx', async () => {
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockResolvedValue(res(503));

    const p = uploadChunk(SESSION, token, 0, blob(100), 100, true);
    const expectation = expect(p).rejects.toThrow(/after retries/);
    await jest.advanceTimersByTimeAsync(60_000);
    await expectation;
    // One PUT + one recovery probe per attempt.
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(DRIVE_MAX_RETRIES * 2);
  });

  it('throws immediately on a non-retryable status', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(res(400));
    await expect(uploadChunk(SESSION, token, 0, blob(100), 100, true)).rejects.toThrow(/Drive PUT failed/);
  });
});
