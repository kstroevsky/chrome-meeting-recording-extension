import type { BrowserContext } from '@playwright/test';
import { createHash } from 'node:crypto';

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
  revisionUpdates: number;
  permissionCreates: number;
  permissionDeletes: number;
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
  mimeType: string;
  totalBytes: number | null;
  committedEnd: number;
  dataAttempts: number;
  data: Buffer | null;
};

type InterceptedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
  postDataBase64?: string;
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

type DrivePermission = {
  id: string;
  type: 'user';
  role: 'reader';
  emailAddress: string;
};

const mediaContent = new Map<string, Buffer>();
const mediaNames = new Map<string, string>();
const mediaMimeTypes = new Map<string, string>();
const revisionIds = new Map<string, string>();
const revisionPinned = new Map<string, boolean>();
const filePermissions = new Map<string, DrivePermission[]>();
let permissionSequence = 0;

function revisionIdFor(fileId: string): string {
  let revisionId = revisionIds.get(fileId);
  if (!revisionId) {
    revisionId = `revision-${fileId}`;
    revisionIds.set(fileId, revisionId);
  }
  return revisionId;
}

function registerMedia(fileId: string, bytes: Buffer, name: string, mimeType = 'video/webm'): void {
  mediaContent.set(fileId, Buffer.from(bytes));
  mediaNames.set(fileId, name);
  mediaMimeTypes.set(fileId, mimeType);
  revisionIdFor(fileId);
  if (!revisionPinned.has(fileId)) revisionPinned.set(fileId, false);
  if (!filePermissions.has(fileId)) filePermissions.set(fileId, []);
}

function checksum(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('hex');
}

export type DriveSimulatorRelayFile = {
  fileId: string;
  revisionId: string;
  bytes: Buffer;
  name: string;
  mimeType: string;
  md5Checksum: string;
  keepForever: boolean;
  permissions: DrivePermission[];
};

export function getDriveSimulatorRelayFile(fileId: string): DriveSimulatorRelayFile | undefined {
  const bytes = mediaContent.get(fileId);
  if (!bytes) return undefined;
  return {
    fileId,
    revisionId: revisionIdFor(fileId),
    bytes: Buffer.from(bytes),
    name: mediaNames.get(fileId) ?? fileId,
    mimeType: mediaMimeTypes.get(fileId) ?? 'video/webm',
    md5Checksum: checksum(bytes),
    keepForever: revisionPinned.get(fileId) === true,
    permissions: structuredClone(filePermissions.get(fileId) ?? []),
  };
}

export function resetDriveSimulatorSharingState(): void {
  mediaContent.clear();
  mediaNames.clear();
  mediaMimeTypes.clear();
  revisionIds.clear();
  revisionPinned.clear();
  filePermissions.clear();
  permissionSequence = 0;
}

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
        const revisionId = revisionIdFor(id);
        return record({
          status: 200,
          body: JSON.stringify({
            id,
            name: mediaNames.get(id) ?? id,
            size: String(media.length),
            trashed: false,
            headRevisionId: revisionId,
            mimeType: mediaMimeTypes.get(id) ?? 'video/webm',
            md5Checksum: checksum(media),
            capabilities: { canDownload: true },
          }),
        });
      }
      const name = resources.get(id);
      stats.metadataReads += 1;
      return name == null
        ? record({ status: 404, body: JSON.stringify({ error: { message: 'Unknown mock resource' } }) })
        : record({ status: 200, body: JSON.stringify({ id, name, parents: parents.get(id) ?? [] }) });
    }

    const revisionMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/revisions\/([^/]+)$/);
    if (revisionMatch) {
      const fileId = decodeURIComponent(revisionMatch[1]);
      const revisionId = decodeURIComponent(revisionMatch[2]);
      const media = mediaContent.get(fileId);
      if (!media || revisionIdFor(fileId) !== revisionId) {
        return record({ status: 404, body: JSON.stringify({ error: { message: 'Unknown mock revision' } }) });
      }
      if (method === 'PATCH') {
        let body: { keepForever?: boolean } = {};
        try { body = request.postData ? JSON.parse(request.postData) : {}; } catch {}
        if (typeof body.keepForever !== 'boolean') {
          return record({ status: 400, body: JSON.stringify({ error: { message: 'Missing keepForever' } }) });
        }
        revisionPinned.set(fileId, body.keepForever);
        stats.revisionUpdates += 1;
        return record({
          status: 200,
          body: JSON.stringify({ id: revisionId, keepForever: body.keepForever }),
        });
      }
      if (method === 'DELETE') {
        revisionPinned.set(fileId, false);
        stats.revisionUpdates += 1;
        return record({ status: 204, body: '' });
      }
      if (method === 'GET') {
        return record({
          status: 200,
          body: JSON.stringify({
            id: revisionId,
            size: String(media.length),
            mimeType: mediaMimeTypes.get(fileId) ?? 'video/webm',
            md5Checksum: checksum(media),
            keepForever: revisionPinned.get(fileId) === true,
          }),
        });
      }
    }

    const permissionsMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/);
    if (permissionsMatch) {
      const fileId = decodeURIComponent(permissionsMatch[1]);
      if (!mediaContent.has(fileId)) {
        return record({ status: 404, body: JSON.stringify({ error: { message: 'Unknown mock media' } }) });
      }
      if (method === 'GET') {
        return record({
          status: 200,
          body: JSON.stringify({ permissions: filePermissions.get(fileId) ?? [] }),
        });
      }
      if (method === 'POST') {
        let body: { type?: string; role?: string; emailAddress?: string } = {};
        try { body = request.postData ? JSON.parse(request.postData) : {}; } catch {}
        if (body.type !== 'user' || body.role !== 'reader' || !body.emailAddress) {
          return record({ status: 400, body: JSON.stringify({ error: { message: 'Invalid permission' } }) });
        }
        const permission: DrivePermission = {
          id: `permission-${++permissionSequence}`,
          type: 'user',
          role: 'reader',
          emailAddress: body.emailAddress,
        };
        filePermissions.set(fileId, [...(filePermissions.get(fileId) ?? []), permission]);
        stats.permissionCreates += 1;
        return record({ status: 201, body: JSON.stringify({ id: permission.id }) });
      }
    }

    const permissionMatch = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)\/permissions\/([^/]+)$/);
    if (permissionMatch && method === 'DELETE') {
      const fileId = decodeURIComponent(permissionMatch[1]);
      const permissionId = decodeURIComponent(permissionMatch[2]);
      const current = filePermissions.get(fileId);
      if (!current) return record({ status: 404, body: '' });
      const next = current.filter((permission) => permission.id !== permissionId);
      if (next.length === current.length) return record({ status: 404, body: '' });
      filePermissions.set(fileId, next);
      stats.permissionDeletes += 1;
      return record({ status: 204, body: '' });
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
        mimeType: typeof (metadata as { mimeType?: unknown }).mimeType === 'string'
          ? (metadata as { mimeType: string }).mimeType
          : header(request.headers, 'x-upload-content-type') ?? 'application/octet-stream',
        totalBytes: null,
        committedEnd: -1,
        dataAttempts: 0,
        data: null,
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
        if (session.totalBytes != null && session.committedEnd + 1 >= session.totalBytes) {
          return record({
            status: 200,
            body: JSON.stringify({ id: `mock-file-${id}`, name: session.filename }),
            sessionId: id,
          });
        }
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
      session.data ??= Buffer.alloc(range.total);
      const payload = request.postDataBase64 != null
        ? Buffer.from(request.postDataBase64, 'base64')
        : Buffer.from(request.postData ?? '', 'utf8');
      if (payload.length !== range.end - range.start + 1) {
        return record({
          status: 400,
          body: JSON.stringify({ error: { message: 'Mock upload payload length mismatch' } }),
          sessionId: id,
        });
      }
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
          payload.subarray(0, committedBytes).copy(session.data!, range.start);
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
          const payloadOffset = newlyCommittedStart - range.start;
          payload.subarray(payloadOffset).copy(session.data!, newlyCommittedStart);
          stats.uploadedBytes += range.end - newlyCommittedStart + 1;
        }
        session.committedEnd = Math.max(session.committedEnd, range.end);
        const isFinal = session.committedEnd + 1 >= range.total;
        if (isFinal) {
          const resourceId = `mock-file-${id}`;
          resources.set(resourceId, session.filename);
          stats.resources[resourceId] = session.filename;
          registerMedia(resourceId, session.data!, session.filename, session.mimeType);
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
  registerMedia(fileId, bytes, name);
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
    mediaReads: [],
    metadataReads: 0,
    metadataUpdates: 0,
    revisionUpdates: 0,
    permissionCreates: 0,
    permissionDeletes: 0,
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
      postDataBase64: request.postDataBuffer()?.toString('base64'),
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
