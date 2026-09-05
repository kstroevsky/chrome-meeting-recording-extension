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

/** One `alt=media` read, so a test can assert what the media stack asked for. */
export type DriveMediaRead = {
  fileId: string;
  range: string | null;
  start: number;
  end: number;
  status: number;
  authorized: boolean;
};

export type DriveSimulatorStats = {
  profile: DriveSimulatorProfile;
  /** Bytes served per file id, registered by the test. */
  mediaReads: DriveMediaRead[];
  folderLookups: number;
  foldersCreated: number;
  sessionsCreated: number;
  dataPuts: number;
  statusProbes: number;
  retryResponses: number;
  authFailures: number;
  permanentFailures: number;
  metadataReads: number;
  metadataUpdates: number;
  /** Folder re-parents, i.e. recordings filed into a destination. */
  folderMoves: number;
  activeUploads: number;
  maxConcurrentUploads: number;
  uploadedBytes: number;
  resources: Record<string, string>;
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
  /** Set for `alt=media`; fulfilled as bytes rather than JSON. */
  bytes?: Buffer;
  contentType?: string;
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
  const resources = new Map<string, string>();
  let folderSequence = 0;
  let sessionSequence = 0;
  const parents = new Map<string, string[]>();

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
      let metadata: { name?: string } = {};
      try {
        metadata = request.postData ? JSON.parse(request.postData) : {};
      } catch {}
      const id = `mock-folder-${folderSequence}`;
      const name = metadata.name ?? id;
      resources.set(id, name);
      stats.resources[id] = name;
      parents.set(id, Array.isArray((metadata as { parents?: string[] }).parents)
        ? (metadata as { parents: string[] }).parents
        : []);
      return record({
        status: 200,
        body: JSON.stringify({ id, name }),
      });
    }

    // Playback: `files.get?alt=media`. Real Drive answers 206 with Content-Range
    // and — measured 2026-09-04 — no redirect and no Accept-Ranges header, so
    // this mirrors that rather than an idealised range server.
    const mediaMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (mediaMatch && method === 'GET' && url.searchParams.get('alt') === 'media') {
      const id = decodeURIComponent(mediaMatch[1]);
      const content = mediaContent.get(id);
      const authorized = Boolean(authorization);
      if (!content) {
        return record({ status: 404, body: JSON.stringify({ error: { message: 'Unknown mock media' } }) });
      }
      /*
       * Deliberately serves media whether or not the request carries a bearer
       * token, and records which. Playwright's request interception fulfils a
       * request before declarativeNetRequest's `modifyHeaders` runs, so the
       * DNR-injected header is structurally unobservable here — 401ing would
       * only assert a limitation of the harness. That the rule reaches the wire
       * is proven against real Drive in `tests/spikes/drive-playback`; what a
       * test *can* check here is the installed rule's shape and that the token
       * never reaches the page.
       */
      const rangeHeader = header(request.headers, 'range');
      const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : content.length - 1;
      const clampedEnd = Math.min(end, content.length - 1);
      const partial = Boolean(match);
      stats.mediaReads.push({
        fileId: id, range: rangeHeader ?? null, start, end: clampedEnd,
        status: partial ? 206 : 200, authorized: true,
      });
      return record({
        status: partial ? 206 : 200,
        bytes: content.subarray(start, clampedEnd + 1),
        contentType: 'video/webm',
        headers: partial
          ? { 'Content-Range': `bytes ${start}-${clampedEnd}/${content.length}` }
          : { 'Content-Length': String(content.length) },
      });
    }

    const metadataMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (metadataMatch && method === 'GET') {
      const id = decodeURIComponent(metadataMatch[1]);
      // A file registered for playback has metadata too — the player verifies a
      // file exists (and is not trashed) before asking for authorization.
      const media = mediaContent.get(id);
      if (media) {
        stats.metadataReads += 1;
        return record({
          status: 200,
          body: JSON.stringify({ id, name: mediaNames.get(id) ?? id, size: String(media.length), trashed: false }),
        });
      }
      const name = resources.get(id);
      stats.metadataReads += 1;
      return name == null
        ? record({ status: 404, body: JSON.stringify({ error: { message: 'Unknown mock resource' } }) })
        : record({ status: 200, body: JSON.stringify({ id, name, parents: parents.get(id) ?? [] }) });
    }

    if (metadataMatch && method === 'PATCH') {
      const id = decodeURIComponent(metadataMatch[1]);
      if (!resources.has(id)) {
        return record({ status: 404, body: JSON.stringify({ error: { message: 'Unknown mock resource' } }) });
      }
      // Real Drive re-parents through query params with an empty body, so a
      // PATCH carrying only addParents/removeParents is a move, not a rename.
      const addParents = url.searchParams.get('addParents');
      const removeParents = url.searchParams.get('removeParents');
      if (addParents || removeParents) {
        const current = new Set(parents.get(id) ?? []);
        for (const parent of (removeParents ?? '').split(',').filter(Boolean)) current.delete(parent);
        for (const parent of (addParents ?? '').split(',').filter(Boolean)) current.add(parent);
        parents.set(id, [...current]);
        stats.folderMoves += 1;
        return record({ status: 200, body: JSON.stringify({ id, parents: [...current] }) });
      }
      let metadata: { name?: string } = {};
      try {
        metadata = request.postData ? JSON.parse(request.postData) : {};
      } catch {}
      if (typeof metadata.name !== 'string') {
        return record({ status: 400, body: JSON.stringify({ error: { message: 'Missing resource name' } }) });
      }
      resources.set(id, metadata.name);
      stats.resources[id] = metadata.name;
      stats.metadataUpdates += 1;
      return record({ status: 200, body: JSON.stringify({ id, name: metadata.name }) });
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
        if (isFinal) {
          const resourceId = `mock-file-${id}`;
          resources.set(resourceId, session.filename);
          stats.resources[resourceId] = session.filename;
        }
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

/** Registers bytes a test wants `alt=media` to serve for one file id. */
export function setDriveMediaContent(fileId: string, bytes: Buffer, name = fileId): void {
  mediaContent.set(fileId, bytes);
  mediaNames.set(fileId, name);
}

const mediaContent = new Map<string, Buffer>();
const mediaNames = new Map<string, string>();

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
    mediaReads: [],
    metadataReads: 0,
    metadataUpdates: 0,
    folderMoves: 0,
    activeUploads: 0,
    maxConcurrentUploads: 0,
    uploadedBytes: 0,
    resources: {},
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
      contentType: response.contentType ?? 'application/json',
      ...(response.bytes ? { body: response.bytes } : { body: response.body ?? '' }),
    });
  });
  return stats;
}
