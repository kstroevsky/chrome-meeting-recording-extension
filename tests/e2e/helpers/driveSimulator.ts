import type { BrowserContext } from '@playwright/test';

export type DriveSimulatorProfile =
  | 'fast'
  | 'throttled'
  | 'retry'
  | 'partial-commit'
  | 'token-refresh'
  | 'permanent-failure';

export type DriveRequestRecord = {
  method: string;
  url: string;
  authorization: string | null;
  contentRange: string | null;
  status: number;
  sessionId: string | null;
};

export type DriveSimulatorStats = {
  profile: DriveSimulatorProfile;
  folderLookups: number;
  foldersCreated: number;
  sessionsCreated: number;
  dataPuts: number;
  statusProbes: number;
  retryResponses: number;
  authFailures: number;
  permanentFailures: number;
  activeUploads: number;
  maxConcurrentUploads: number;
  uploadedBytes: number;
  requests: DriveRequestRecord[];
};

type SessionState = {
  id: string;
  filename: string;
  totalBytes: number | null;
  committedEnd: number;
  dataAttempts: number;
};

type InterceptedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
};

type MockResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  sessionId?: string | null;
  contentRange?: string | null;
};

const SESSION_PREFIX = 'https://www.googleapis.com/upload/mock-drive-session/';

function parseDataRange(value: string | null): {
  start: number;
  end: number;
  total: number;
} | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3]),
  };
}

async function pause(ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

function header(
  headers: Record<string, string>,
  name: string
): string | null {
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase()
  );
  return key ? headers[key] : null;
}

function createHandler(
  profile: DriveSimulatorProfile,
  throttleMs: number,
  stats: DriveSimulatorStats
) {
  const sessions = new Map<string, SessionState>();
  let folderSequence = 0;
  let sessionSequence = 0;

  return async (request: InterceptedRequest): Promise<MockResponse> => {
    const url = new URL(request.url);
    const method = request.method;
    const contentRange = header(request.headers, 'content-range');
    const authorization = header(request.headers, 'authorization');
    const record = (
      response: Omit<MockResponse, 'contentRange'> & { contentRange?: string | null }
    ): MockResponse => {
      stats.requests.push({
        method,
        url: request.url,
        authorization,
        contentRange: response.contentRange ?? contentRange,
        status: response.status,
        sessionId: response.sessionId ?? null,
      });
      return response;
    };

    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      stats.folderLookups += 1;
      return record({ status: 200, body: JSON.stringify({ files: [] }) });
    }

    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      folderSequence += 1;
      stats.foldersCreated += 1;
      return record({
        status: 200,
        body: JSON.stringify({ id: `mock-folder-${folderSequence}` }),
      });
    }

    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      sessionSequence += 1;
      const id = String(sessionSequence);
      let metadata: { name?: string } = {};
      try {
        metadata = request.postData ? JSON.parse(request.postData) : {};
      } catch {}
      sessions.set(id, {
        id,
        filename: metadata.name ?? `artifact-${id}.webm`,
        totalBytes: null,
        committedEnd: -1,
        dataAttempts: 0,
      });
      stats.sessionsCreated += 1;
      return record({
        status: 200,
        headers: { Location: `${SESSION_PREFIX}${id}` },
        body: JSON.stringify({ id: `mock-file-${id}` }),
        sessionId: id,
      });
    }

    if (url.href.startsWith(SESSION_PREFIX) && method === 'PUT') {
      const id = url.pathname.split('/').pop() ?? '';
      const session = sessions.get(id);
      if (!session) {
        return record({
          status: 404,
          body: JSON.stringify({ error: { message: 'Unknown mock upload session' } }),
          sessionId: id,
        });
      }

      if (contentRange?.startsWith('bytes */')) {
        stats.statusProbes += 1;
        return record({
          status: 308,
          headers: session.committedEnd >= 0
            ? { Range: `bytes=0-${session.committedEnd}` }
            : undefined,
          sessionId: id,
        });
      }

      const range = parseDataRange(contentRange);
      if (!range) {
        return record({
          status: 400,
          body: JSON.stringify({ error: { message: 'Invalid Content-Range' } }),
          sessionId: id,
        });
      }

      session.totalBytes = range.total;
      session.dataAttempts += 1;
      stats.dataPuts += 1;
      stats.activeUploads += 1;
      stats.maxConcurrentUploads = Math.max(
        stats.maxConcurrentUploads,
        stats.activeUploads
      );

      try {
        await pause(profile === 'throttled' ? throttleMs : 0);

        if (profile === 'permanent-failure') {
          stats.permanentFailures += 1;
          return record({
            status: 403,
            body: JSON.stringify({ error: { message: 'Mock permanent failure' } }),
            sessionId: id,
          });
        }

        if (profile === 'token-refresh' && session.dataAttempts === 1) {
          stats.authFailures += 1;
          return record({
            status: 401,
            body: JSON.stringify({ error: { message: 'Mock expired token' } }),
            sessionId: id,
          });
        }

        if (profile === 'retry' && session.dataAttempts === 1) {
          stats.retryResponses += 1;
          return record({
            status: 503,
            body: JSON.stringify({ error: { message: 'Mock transient failure' } }),
            sessionId: id,
          });
        }

        if (profile === 'partial-commit' && session.dataAttempts === 1) {
          const committedBytes = Math.max(1, Math.floor((range.end - range.start + 1) / 2));
          session.committedEnd = range.start + committedBytes - 1;
          stats.uploadedBytes += committedBytes;
          stats.retryResponses += 1;
          return record({
            status: 503,
            body: JSON.stringify({ error: { message: 'Mock partial commit' } }),
            sessionId: id,
          });
        }

        const newlyCommittedStart = Math.max(range.start, session.committedEnd + 1);
        if (range.end >= newlyCommittedStart) {
          stats.uploadedBytes += range.end - newlyCommittedStart + 1;
        }
        session.committedEnd = Math.max(session.committedEnd, range.end);
        const isFinal = session.committedEnd + 1 >= range.total;
        return record({
          status: isFinal ? 200 : 308,
          headers: isFinal ? undefined : { Range: `bytes=0-${session.committedEnd}` },
          body: isFinal
            ? JSON.stringify({ id: `mock-file-${id}`, name: session.filename })
            : '',
          sessionId: id,
        });
      } finally {
        stats.activeUploads = Math.max(0, stats.activeUploads - 1);
      }
    }

    return record({
      status: 404,
      body: JSON.stringify({ error: { message: `Unhandled mock Drive URL ${url.href}` } }),
    });
  };
}

export async function installDriveSimulator(
  context: BrowserContext,
  profile: DriveSimulatorProfile,
  options: { throttleMs?: number } = {}
): Promise<DriveSimulatorStats> {
  const stats: DriveSimulatorStats = {
    profile,
    folderLookups: 0,
    foldersCreated: 0,
    sessionsCreated: 0,
    dataPuts: 0,
    statusProbes: 0,
    retryResponses: 0,
    authFailures: 0,
    permanentFailures: 0,
    activeUploads: 0,
    maxConcurrentUploads: 0,
    uploadedBytes: 0,
    requests: [],
  };
  const handle = createHandler(profile, options.throttleMs ?? 300, stats);

  await context.route('https://www.googleapis.com/**', async (route) => {
    const request = route.request();
    const response = await handle({
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      postData: request.postData() ?? undefined,
    });
    await route.fulfill({
      status: response.status,
      headers: response.headers,
      contentType: 'application/json',
      body: response.body ?? '',
    });
  });
  return stats;
}
