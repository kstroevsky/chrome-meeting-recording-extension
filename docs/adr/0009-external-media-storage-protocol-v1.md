# ADR-0009 — External Media Storage Protocol V1

- **Status:** Accepted for implementation (wire contract; rollout gated by JM0–JM19)
- **Date:** 2026-10-08
- **Origin:** CheekyCheese CRM integration plan, PLAN C; follows ADR-0008.
- **Scope:** A generic private media destination, independent of R2, S3 or the CRM.

## Decision and trust boundary

A media-capable destination advertises the protocol
`io.github.kstroevsky.meeting-recorder.service.v1` in the signed test-event
response (HTTP 200). An events-only destination continues returning HTTP 204.
Only the test event discovers capabilities; other webhook events keep HTTP 204.

`capabilities.media.version = 1`, `apiBase`, `upload.strategy =
"multipart-put-v1"`, `upload.origins`, and `playback.strategy =
"refreshable-url-v1"` form the capability contract. The `apiBase` URL is HTTPS
and must have the **exact same origin** as the configured webhook URL. Each
`upload.origins` member is an exact HTTPS origin, never a wildcard, path,
query or username; the browser obtains host permission with user involvement.
Any unexpected URL or redirected request to a new origin fails closed.
An upload-part URL must be HTTPS and match one granted origin. Playback URLs
must be HTTPS. Never send the destination credential to a storage URL.

The destination uses a per-connection Bearer token (or an explicitly configured
equivalent), separate from Standard Webhooks signatures. The CRM stores a
SHA-256 hash of a random token and revokes it on replacement. A disabled
connection returns 410 on **every** media API call, including playback; a
connection cannot read another connection's artifacts. The CRM's separate
authenticated-user playback endpoint applies interview RBAC. Presigned URLs
and tokens are secrets: never persist or log them. Errors must not expose
provider/S3 internals, file names or object keys.

## Wire protocol

All paths below are relative to `apiBase`. JSON uses `application/json`.
Opaque `clientTransferId` is stable for one logical artifact *and one
destination connection*, including across process restarts. `recordingId` is
the pseudonymous CloudEvents `externalRecordingId` established at Start.
Every artifact must have its own transfer ID (even when recordingId is shared).

**POST /v1/uploads** accepts:

```json
{
  "clientTransferId": "transfer_...",
  "recordingId": "recording_...",
  "artifact": {
    "role": "tab-recording",
    "filename": "interview.webm",
    "mimeType": "video/webm",
    "bytes": 1482910042
  }
}
```

The service validates a positive safe integer size, a role in
`tab-recording | microphone-recording | self-video`, and allowlisted base MIME
type `video/webm | video/mp4 | audio/webm | audio/mp4`; codec parameters
are discarded. Filenames are metadata only (255 characters maximum, control
characters stripped). File names, recording titles and client-supplied paths
never enter storage keys or response headers. A fresh upload returns:

```json
{
  "artifactId": "media_...",
  "uploadId": "upload_...",
  "state": "uploading",
  "strategy": "multipart-put-v1",
  "partSize": 33554432,
  "maxConcurrency": 3
}
```

The server chooses a **binding** part size of 5–256 MiB, with at most 10,000
parts, and reports concurrency within its policy. Every part except the final
one has exactly `partSize` bytes. The client rejects unsupported size or
concurrency parameters before moving bytes.

**Idempotency and restart:** create is keyed by
`(connectionId, clientTransferId)`. Its immutable fingerprint includes
`recordingId`, role, canonical MIME, bytes, and original filename metadata.
Changing it returns 409. An active repeated create returns the *same*
artifactId and uploadId, with identical part parameters; a completed repeated
create returns `{"artifactId":"media_...","state":"ready"}`. If a multipart
session expired/was aborted, a repeated create with the *same* transfer ID
returns the **same artifactId but a new uploadId**, `state:"uploading"`,
and a new multipart session. It never allocates a second artifact. Previous
upload IDs remain expired (410); a new create must not race a still-active
upload. An atomic database state transition/unique constraint and cleanup of
orphaned storage sessions are required.

**POST /v1/uploads/{uploadId}/parts/{partNumber}** returns
`{"method":"PUT","url":"https://...","headers":{},"expiresAt":"ISO-8601"}`.
`partNumber` is one-based and bounded by `ceil(bytes / partSize)`.
The client reads exactly
`[(partNumber-1)*partSize, min(partNumber*partSize,bytes))`,
uploads its Blob, and captures the **entire opaque ETag value** returned by
storage (including any quotes). It never sends a Bearer header to the signed
storage URL, follows no cross-origin redirects, and requests a new URL after
a signed URL expires. Part URL TTL is 15 minutes by default.

**GET /v1/uploads/{uploadId}** returns either:

```json
{
  "state": "uploading",
  "artifactId": "media_...",
  "uploadedParts": [
    {"partNumber": 1, "etag": "\"part-etag-one\""},
    {"partNumber": 2, "etag": "\"part-etag-two\""}
  ]
}
```

or `{"state":"ready","artifactId":"media_..."}`. Expired IDs return 410;
the client repeats create with its original transfer ID to restart. The
backend verifies actual uploaded parts with the storage provider (ListParts)
when resuming, including pagination; a cached client list is not authoritative.
Upload state and ETags may be persisted locally, but presigned URLs may not.

**POST /v1/uploads/{uploadId}/complete** accepts an ordered part manifest:

```json
{
  "parts": [
    {"partNumber": 1, "etag": "\"part-etag-one\""},
    {"partNumber": 2, "etag": "\"part-etag-two\""}
  ]
}
```

Parts are exactly 1..N, unique and ascending, and their ETags must match
provider ListParts. The service uses the provider's multipart completion API,
then independently verifies the object's size via HEAD (and checks its
stored content type). It only marks the artifact `ready` after this succeeds.
The response is `{"artifactId":"media_...","state":"ready"}`.

**Completion recovery:** if the storage provider completed the object but
the HTTP response was lost, retrying complete or create returns `ready` for
the *same artifact* once the server verifies HEAD. Persist a durable
`completing` state before the provider call; reconcile ambiguous failure via
HEAD, never assume the old multipart upload still exists. A mismatch or
missing object must not create a playable location. Ensure two competing
completions cannot each mutate the object.

**POST /v1/artifacts/{artifactId}/playback** returns
`{"url":"https://...","expiresAt":"ISO-8601"}`, refreshed on demand.
Default TTL: 30 minutes. GET on this capability URL supports HTTP Range
(206 and Content-Range), for native browser seeking. It is private,
short-lived, and no-store. CRM-user playback is a *separate* endpoint subject
to CRM interview scope, never authorized merely by this extension credential.

## Error and durability rules

- 401: missing/invalid credential; 403: authenticated but wrong owner; 404:
  unknown resource; 409: conflicting create or wrong lifecycle state; 410:
  disabled connection or expired upload; 413: over size cap; 422: malformed
  or unsupported artifact; 429 and 5xx: retry with backoff.
- Rate limits: 600 media requests/minute per connection and at most four
  active uploads. Retention, maximum size and quota are configured per
  destination, disclosed before media delivery (plan O11).
- Storage keys use generated server IDs under `meeting-recordings/`, never
  client data. Stale multipart uploads and orphaned objects have a dedicated
  media reconciler. CRM document reconciliation must ignore this prefix.
- Multipart state and signed URLs are separate. The offscreen data plane
  persists IDs, parts and progress in IndexedDB, bounds in-flight bytes and
  concurrency, and keeps OPFS source bytes until verified playback. Automatic
  third-party export respects the end-of-recording confirmation hold.
- M1 first creates an **additional** CRM replica. M2 implements remote
  playback and safe disconnect before M5 permits remote-only storage.
- Real R2 presigned UploadPart and ranged playback must pass JM1 in a real
  Chromium run. Neither unit tests nor an S3 emulator close that gate.

## Compatibility and verification

This ADR extends ADR-0008 but does not alter its CloudEvents or Standard
Webhooks V1 payloads. Existing events-only receivers and recordings continue
to work. Verify duplicate create, divergent duplicate conflict, expired
replacement without duplicate artifact, lost complete response, paginated
part recovery, cross-connection isolation, disabled-connection revocation,
cross-origin URL rejection, exact part lengths, Range playback, and the
PLAN C JM0–JM19 gates before rolling out external media.
