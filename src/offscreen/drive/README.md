# Drive Upload — resumable upload, OAuth token use & crash recovery

> Part of the [offscreen runtime](../README.md) (data plane). Uploads a sealed recording to Google Drive. For symbol-level structure use codegraph (`codegraph_explore "DriveChunkUploader DriveFolderResolver resumePendingUploads"`); this doc explains the wire protocols and the failure handling around them. The per-file orchestrator `DriveTarget` lives one level up at [`../DriveTarget.ts`](../DriveTarget.ts); this folder is the protocol layer it drives.

> **Archetype:** *External Integration*. The defining property here is that **the other side is a remote HTTP API we don't control** — so this README leads with the two wire protocols (resumable upload, OAuth token use) as sequence diagrams and a status-code-driven failure table. Token *acquisition* (the browser-specific consent flow) is a separate seam — see [`platform/capabilities`](../../platform/capabilities/README.md); this folder only *uses* tokens. If you read one section, read **The resumable-upload protocol**.

## Purpose & mental model

Upload a finished, sealed recording file to Drive **durably over a flaky network**: chunk it, drive a [resumable session](https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable), recover from partial commits and transient failures, and — if the whole offscreen document dies mid-upload — resume on the next launch. A recording can be several files (tab, separate mic, self-video); each is one `DriveTarget` upload, and up to `parallelUploadConcurrency` of them run **concurrently across files** (a single resumable session is inherently sequential by byte-range, so the concurrency is between files, never within one session).

## The resumable-upload protocol

```mermaid
sequenceDiagram
    participant DT as DriveTarget
    participant FR as DriveFolderResolver
    participant CU as uploadChunk
    participant G as Google Drive

    DT->>FR: resolveUploadParentId(root, recording)
    FR->>G: find-or-create folders (Files API)
    G-->>FR: parent folder id
    DT->>G: POST resumable session (metadata + parent)
    G-->>DT: 200 + session URI
    loop each chunk (adaptive size)
        CU->>G: PUT Content-Range bytes start-end of total
        alt more chunks remain
            G-->>CU: 308 Resume Incomplete
        else final chunk
            G-->>CU: 200 / 201 created
        end
    end
```

- The session is created once (`DRIVE_UPLOAD_URL`, `uploadType=resumable`); Drive returns a **session URI** that every chunk `PUT`s to.
- Each chunk carries `Content-Range: bytes <start>-<end>/<total>` and `Content-Type: video/webm`. A non-final chunk that lands returns **`308`** (Resume Incomplete) → advance `start`; the final chunk returns **`200/201`** → done.
- **Partial-commit recovery** (`recoverFromCommittedState`): on a transient failure mid-chunk, re-query the session with `Content-Range: bytes */<total>`, read Drive's `Range` header to learn the committed offset, and **slice the body forward** to exactly what's missing — so a retry never re-sends committed bytes or leaves a gap.

## The OAuth token flow (use, not acquisition)

```mermaid
sequenceDiagram
    participant CU as uploadChunk
    participant TP as cached TokenProvider
    participant AU as driveAuth (background)
    participant ID as AuthProvider

    CU->>TP: getUploadToken()
    TP-->>CU: cached token (no network)
    Note over CU: Drive returns 401 / 403
    CU->>TP: getUploadToken(refresh)
    TP->>AU: fetchDriveTokenWithFallback
    AU->>ID: getToken(silent)
    alt silent ok
        ID-->>AU: token
    else needs consent
        AU->>ID: getToken(interactive)
        ID-->>AU: token
    end
    AU-->>TP: fresh token
    TP-->>CU: refreshed token, retry once
```

- **`createCachedTokenProvider`** holds one token in memory for the whole upload so we don't call the identity API per chunk; a `refresh` bumps a generation counter (so a stale in-flight load can't overwrite the new token) and forces one re-fetch.
- A `401/403` triggers exactly **one** refreshed retry (both in `uploadChunk` for PUTs and `fetchWithAuthRetry` for folder ops). Token **acquisition** (silent→interactive fallback, bad-client-id diagnosis) is `background/driveAuth.ts` behind the [`AuthProvider`](../../platform/capabilities/README.md) seam (ADR-0002) — this folder treats it as a black box that returns a string.

## Failure modes & retry/backoff

The status-code contract `uploadChunk` enforces (`DRIVE_MAX_RETRIES = 5`, exponential backoff `1 s` base capped at `8×`):

| Drive response | Action |
| :--- | :--- |
| `308` (non-final) | chunk committed → advance to next chunk |
| `200` / `201` (final) | upload complete |
| `401` / `403` | refresh token, retry once |
| `429` / `408` / `5xx` | recover committed offset → backoff → retry (≤5) |
| transient fetch (`AbortError`/`TypeError`, incl. the 180 s `DRIVE_REQUEST_TIMEOUT_MS` abort) | recover committed offset → backoff → retry (≤5) |
| other `4xx` | throw `formatDriveError` — status + detail **+ an actionable hint** (missing scope, Drive API not enabled, unverified consent screen, …) |

`formatDriveError` is deliberately user-actionable: a `403 insufficient scope` becomes "confirm `manifest oauth2.scopes` includes `drive.file` and re-consent", not a raw payload dump.

## Crash recovery — re-upload fresh, never resume

If the offscreen document dies mid-upload, recovery does **not** resume the abandoned session. Why: the marker (`PendingUploadStore`) intentionally does **not** store the session URI, because the on-disk OPFS bytes are the *raw, pre-duration-fix* recording — splicing them onto the duration-fixed prefix the old session already committed would silently corrupt the file. So `resumePendingDriveUploads` re-opens the raw OPFS file, **re-runs the duration fix**, and uploads through a **brand-new** resumable session. It re-sends already-committed bytes only in the rare crash case, in exchange for guaranteed correctness.

- **`PendingUploadStore`** writes **one `chrome.storage.local` key per file** (prefix-namespaced), *not* a single map — so the concurrent (across-files) uploader's `put`/`remove` can never lose each other to a read-modify-write race.
- The marker is cleared **the instant** Drive confirms the upload (before deleting the OPFS file), to keep the "crashed between Drive's 200 and our cleanup" duplicate window as small as possible.
- A marker whose OPFS file is already gone (saved locally instead) is simply dropped; an upload failure leaves the marker for the next launch.

## Folder resolution

`DriveFolderResolver` resolves `rootFolderName / recordingFolderName` to a parent id, creating folders as needed (`DRIVE_ROOT_FOLDER_NAME = "Google Meet Records"`). It caches the recording-folder promise **statically** (shared across `DriveTarget` instances in a run, so the several files of one recording resolve the folder once and race-free), evicting the cache entry on failure. Folder-name lookups escape the Drive query literal (`'` and `\`) to keep the `q=` search safe.

## Configuration & flags

| Constant / flag | Value | Role |
| :--- | :--- | :--- |
| `DRIVE_UPLOAD_CHUNK_BYTES` | 2 MB | default chunk size |
| `DRIVE_MIN/MAX_UPLOAD_CHUNK_BYTES` | 1–8 MB | adaptive bounds |
| `DRIVE_UPLOAD_CHUNK_STEP_BYTES` | 1 MB | adaptive step |
| `DRIVE_FAST/SLOW_CHUNK_MS` | 1.5 s / 8 s | grow / shrink thresholds |
| `DRIVE_MAX_RETRIES` | 5 | transient-retry cap |
| `DRIVE_REQUEST_TIMEOUT_MS` | 180 s | per-PUT abort |
| `dynamicDriveChunkSizing` (perf flag, default on) | — | adapt chunk size to measured throughput |
| `parallelUploadConcurrency` (perf flag, default 2) | — | files uploaded concurrently (see the [perf roadmap](../../../docs/plans/perf-optimization-roadmap.md)) |

## Observability

Drive upload feeds the `upload.*` section of the perf snapshot (folded by `background/PerfDebugStore` — see the [instrumentation doc](../../../docs/plans/storage-and-instrumentation-architecture.md)): `chunkCount` / `totalChunkBytes`, `retryCount` / `retriedChunkCount`, `lastChunkThroughputMbps`, `fileCount` / `uploadedCount` / `fallbackCount`, `lastFallbackRate`, and `lastConcurrency`. **`lastFallbackRate`** (files that fell back to a local download) is the key health signal for a Drive run; `retryCount` + throughput together diagnose a flaky link vs. a slow one.

## Key invariants & gotchas

- **A resumable session is sequential.** Concurrency is across files only; never issue two byte-range `PUT`s to one session URI.
- **Never store the session URI for recovery** — the raw OPFS bytes don't match what the old session committed (see Crash recovery). Re-upload fresh.
- **Clear the marker before deleting the OPFS file**, not after — minimizes the duplicate window.
- **One token per upload, one refresh per auth failure.** The cached provider's generation counter is what keeps a slow stale fetch from clobbering a freshly-refreshed token.
- **`driveFetch` is the single fetch seam** — in E2E builds it routes through a message bridge to a mock Drive; never call `fetch` directly here or you bypass the test harness.

## Files

| File | Role |
| :--- | :--- |
| `DriveChunkUploader.ts` | the resumable chunk `PUT` loop: byte-range protocol, 308/200 handling, retry/backoff, `recoverFromCommittedState` |
| `DriveFolderResolver.ts` | resolve/create `root/recording` folders, static race-free cache, query escaping |
| `PendingUploadStore.ts` | per-file `chrome.storage.local` crash-recovery markers |
| `resumePendingUploads.ts` | next-launch fresh re-upload of interrupted uploads |
| `request.ts` | `driveFetch` (real / E2E bridge), `createCachedTokenProvider`, `fetchWithAuthRetry` |
| `errors.ts` | `formatDriveError` (status + detail + actionable hint), `readDriveErrorDetail` |
| `constants.ts` | endpoints, chunk-sizing + retry/backoff constants |
| `folderNaming.ts` | derives the recording folder name from filenames |

Orchestrator: [`../DriveTarget.ts`](../DriveTarget.ts) (per-file upload, adaptive chunk sizing, shared folder-resolver/token context).

## How it's wired

`RecordingFinalizer` (offscreen) creates a `DriveTarget` per sealed file and calls `upload(file)`; before/around the upload it writes a `PendingUploadStore` marker so a crash is recoverable. On the next launch, `offscreen.ts` runs `resumePendingDriveUploadsWithChrome`. The token comes from the background's `GET_DRIVE_TOKEN` path (`driveAuth.fetchDriveTokenWithFallback`); on any upload failure the finalizer falls back to a **local download** of that file, so a Drive outage never loses a recording.

## Testing notes

- `__tests__/DriveChunkUploader.test.ts` drives the byte-range protocol against scripted responses (308 chain, 200 final, 401-refresh, 5xx-recover-and-backoff, the `Range`-header committed-offset recovery) — the protocol is unit-tested without a network.
- `__tests__/DriveFolderResolver.test.ts` covers find-vs-create + the static cache; `__tests__/resumePendingUploads.test.ts` covers the fresh-reupload recovery (file-gone → drop, failure → keep marker).
- The full path against a *simulated* Drive is the `@perf-full` Drive-scenario e2e (via the `driveFetch` E2E bridge). Real Google Drive is only exercised by the real-Meet harness.

## Related

- [`platform/capabilities`](../../platform/capabilities/README.md) — token **acquisition** (the `AuthProvider` seam, silent→interactive fallback, ADR-0002 cross-browser).
- [Perf roadmap](../../../docs/plans/perf-optimization-roadmap.md) — `parallelUploadConcurrency` and `dynamicDriveChunkSizing` (both shipped, default-on).
- [`offscreen/storage`](../storage/README.md) — orphan recovery reads the same OPFS files these markers point at.

## External references

- Google Drive API — [Resumable upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads#resumable) (the `308` / `Content-Range` / session-URI protocol) and [Files: create](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create).
- MDN — [`Content-Range`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Range) and [`Range`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Range) (the resume protocol's headers).
- [OAuth 2.0 (RFC 6749)](https://datatracker.ietf.org/doc/html/rfc6749) — the bearer-token model; acquisition specifics live with the auth seam.
