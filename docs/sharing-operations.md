# Sharing deployment and operations

This is the runbook for the Drive-backed sharing service. Google Drive is the durable media origin. Cloudflare Worker + D1 are the access/control plane. R2 is a bounded fixed-TTL read-through cache for new publications; it is not the durable recording store.

## Environments

`sharing-worker/wrangler.jsonc` defines isolated development, staging, and production Worker names, D1 databases, and R2 buckets. Replace placeholder D1 ids, extension origins, OAuth client ids, and sharing-reader email before deploying an environment. Never point staging and production at the same D1 database or R2 bucket.

Build the extension with the matching service origin:

```bash
SHARING_SERVICE_ORIGIN=https://sharing-staging.example.com npm run build
SHARING_SERVICE_ORIGIN=https://sharing.example.com npm run build
```

`SHARING_SERVICE_ORIGIN` must be a bare HTTPS origin. `ALLOWED_EXTENSION_ORIGINS` must contain the exact extension origin for that build.

## Google sharing-reader project

Use a dedicated Google Cloud project for viewer-side Drive reads so sharing traffic is operationally isolated from the extension's normal Drive OAuth project.

Provision it as follows:

1. Enable the Google Drive API.
2. Create one service account, for example `recording-share-reader@<sharing-project>.iam.gserviceaccount.com`.
3. Do not enable domain-wide delegation.
4. Do not grant the service account a user folder or broad Drive share. The extension grants `reader` permission separately on each published media file.
5. Set `GOOGLE_DRIVE_READER_EMAIL` in each Worker environment to that exact service-account email.
6. Create a service-account private key and store it only as the Worker secret `GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY`.

The Worker mints short-lived Google access tokens with the `drive.readonly` scope. Its private key is never stored in D1. The extension keeps the user's Google token locally and uses it for OPFS→Drive uploads, revision pinning, and permission grant/removal.

Set the private key with Wrangler, for example:

```bash
npx wrangler secret put GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY --env production
```

The Worker must not receive user Google refresh tokens. Published files must not be changed to `anyoneWithLink`.

## Cloudflare provisioning and deploy

D1 is required for lifecycle/control metadata. R2 is still required, but only for the temporary cache and migration-era objects.

From `sharing-worker/`:

```bash
npx wrangler d1 create recording-extension-sharing-staging
npx wrangler r2 bucket create recording-extension-sharing-media-staging
npx wrangler d1 migrations apply recording-extension-sharing-staging --remote
npx wrangler deploy --env staging
```

Use the equivalent production resource names for production. Apply migrations before deploying code that depends on them.

Run deployment dry-runs before a real deploy:

```bash
npm run dry-run
npx wrangler deploy --env staging --dry-run
npx wrangler deploy --env production --dry-run
```

## Service secrets and capability-key rotation

Each environment requires:

- `SESSION_KEY` — signs short-lived owner/viewer sessions;
- `CAPABILITY_KEYS_JSON` — capability signing keyring;
- `CAPABILITY_KEY` — migration-era capability secret while a stored share still has `capability_key_id='legacy'`;
- `GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY` — service-account credential for Drive revision reads.

Set them with `wrangler secret put` for the intended environment.

To rotate capability keys without invalidating existing links:

1. Add a new entry to `CAPABILITY_KEYS_JSON` while keeping every key id referenced by a surviving share.
2. Deploy the expanded keyring.
3. Change `CAPABILITY_KEY_ID` to the new id and deploy again. New shares use the new key.
4. Check D1 before removing an old key:

   ```sql
   SELECT capability_key_id, COUNT(*) FROM shares GROUP BY capability_key_id;
   ```

5. Remove an old key only after no surviving share references it. Keep `CAPABILITY_KEY` until no `legacy` rows remain.

Rotating `SESSION_KEY` invalidates current owner/viewer sessions; stored shares and capability links remain.

## Publication and Drive invariants

A new published track is ready only after all of these are true:

- the media exists in the owner's Drive;
- the selected blob revision is marked Keep Forever;
- the sharing-reader service account has an explicit file-level `reader` permission;
- size and MIME type match the public track; checksum is checked when supplied;
- the Worker can independently read metadata for that exact revision with its service account;
- D1 `media_assets` points at that file id + revision id.

For a Drive-backed private recording, publication reuses the existing file. For an OPFS-only recording, the extension first performs a resumable upload to the user's Drive. No new publication path uploads media directly to R2.

Private Drive file ids, revision ids, permission ids, and OPFS keys must never appear in the public manifest, viewer HTML/JS, capability URL, or viewer API. `GET /api/shares/:id/origins` is owner-authenticated and exists only to recover cleanup descriptors.

## R2 cache guardrails

The cache policy is enforced in code, independently of billing alerts:

```text
maximum live cache bytes     8,000,000,000
maximum cache PUTs/day       15,000
cache TTL                    30 hours from cachedAt
maximum media response       8 MiB
```

Expiration is fixed. Cache hits never extend `expiresAt`.

Playback behavior is:

```text
viewer authorization
  → D1 media asset lookup
  → D1 cache-row lookup
  → at most one R2 GetObject on a tracked hit
  → otherwise one Drive revision Range fetch
  → stream to viewer
  → best-effort cache write
```

When cache capacity, PUT budget, R2 availability, or a cache write fails, valid playback still reads Drive. Cache exhaustion must not reject the viewer.

The scheduled job runs hourly at minute 17 (`17 * * * *`). It deletes expired R2 cache objects and releases their D1 `live_bytes` accounting. Do not change this to sliding/hot retention.

Provider pricing and free-tier limits can change independently of this repository. Recheck provider terms before relying on a `$0` deployment target. The application-level cache limits remain the hard safety envelope even when billing alerts are configured.

## Worker request and D1 discipline

Media playback should remain read-heavy:

- do not write D1 for every media Range request;
- viewer authorization uses signed sessions plus indexed share reads;
- `HEAD` media requests use D1 metadata and must not fetch Drive bytes;
- one cache miss performs at most one Drive media fetch, capped at 8 MiB;
- do not add bucket scans or separate R2 `HeadObject` calls to the playback path.

The existing owner admission controls still apply: mutation rate, share count, manifest/track limits, and configured aggregate byte admission. `MAX_OWNER_STORED_BYTES` is admission accounting; durable new-media bytes are stored in the user's Drive rather than developer-owned R2.

## Revoke and delete operations

**Revoke** is public-first:

1. Worker D1 changes `active → revoked`.
2. Every subsequent viewer manifest/media request is denied before cache/Drive access.
3. The online extension removes the service-account file permission.
4. If Drive cleanup fails, the extension persists a cleanup job and retries on a later startup.

R2 cache objects do not need to be synchronously deleted for revocation security because authorization is checked before any media lookup.

**Delete published data** is also server-first and crash-safe:

1. The extension captures owner-private origin descriptors, using the local publication row or owner-only `/origins` endpoint.
2. The Worker revokes if necessary, deletes the share's cache objects and D1 publication/media-asset metadata, and returns idempotent success if the share is already gone.
3. The extension removes the reader permission.
4. If the published revision is still the current head, the extension clears Keep Forever. If it is an obsolete published revision, cleanup may delete that obsolete revision.
5. The extension never deletes the user's recording file, including a Drive file created from an OPFS-only recording during publication.

The owner cleanup job is persisted before the server action. If the successful server response is lost, or Chrome exits after server deletion but before Drive cleanup, the next run can continue from the durable cleanup stage.

The Worker cannot use its reader credential to modify the owner's Drive. Scheduled server retention cleanup therefore persists owner-scoped Drive cleanup candidates before removing the share/media rows. The next extension startup claims those candidates through `POST /api/origin-cleanup/claim-pending`, performs the permission/revision cleanup with the owner's Drive token, and completes the Worker lease. Normal explicit revoke/delete paths still attempt the same cleanup immediately and persist retries locally.

## Scheduled retention cleanup

The hourly scheduled handler also processes lifecycle retention:

- stale `draft`/remote `uploading` shares older than `STALE_DRAFT_TTL_SECONDS` (default 7 days);
- revoked shares older than `REVOKED_RETENTION_SECONDS` (default 30 days);
- old owner rate-limit rows.

For Drive-origin shares, this cleanup removes D1 media assets and their R2 cache entries while retaining any generated `drive_cleanup_candidates` until owner-side Drive cleanup completes. Legacy tracks without `media_asset_id` may still have permanent R2 objects; those are deleted by the migration-compatible cleanup path. Unfinished legacy multipart rows are also abortable during cleanup.

Changing retention values is an operational policy change. Update Wrangler configuration and this runbook together.

## Failure modes

Expected Drive-origin failure behavior:

- **service-account permission removed externally / file deleted / pinned revision unavailable:** origin registration fails or viewer media returns an unavailable-origin error; no public Drive locator is exposed;
- **Drive 403/404 during viewer read:** Worker returns media-origin unavailable without falling back to another revision;
- **Drive 408/429/5xx:** control metadata requests use bounded exponential retry; viewer media responds as temporarily unavailable rather than issuing multiple media fetches inside one request;
- **service-account OAuth token expires:** token acquisition is cached in Worker isolate memory and refreshed when required;
- **R2 cache unavailable/full/over budget:** playback falls through to Drive;
- **Chrome exits during OPFS→Drive upload:** durable session URI/offset allows resumable recovery;
- **origin registration commits but its response is lost:** the local publication remains resumable and startup replay re-registers the same descriptor idempotently;
- **Drive ACL cleanup fails after revoke/delete:** public server action remains effective and local cleanup state retries later.
- **scheduled retention deletes a share while the extension is offline:** the Worker keeps owner-scoped Drive cleanup candidates; startup drains them even when no local share/cleanup job survives.

## Observability

Worker observability is enabled. Structured events intentionally omit share ids, owner ids, capability values, auth tokens, transcript contents, titles, Drive ids, and cache object keys.

Current useful events include:

- `sharing_publication_request_failed` — owner publication/control operation + HTTP status;
- `sharing_finalization_failed` — finalize failure status;
- `sharing_viewer_authorization_failed` — viewer surface + 401/404/410;
- `sharing_cleanup` — cache/share cleanup counts;
- `sharing_cleanup_failed` — scheduled cleanup failure;
- `sharing_request_failed` — unexpected top-level Worker failure + HTTP method.

Monitor sustained origin/finalization failures, viewer failures above normal background noise, Drive-origin 5xx/429 behavior, cleanup failures, R2 cache budget saturation, D1 growth, and Worker request-volume ceilings.

## Viewer support

The owner extension remains Chrome/Chromium MV3-specific for the MVP. The public viewer support target is current Chromium-family desktop browsers.

The sharing E2E opens a capability in a clean Chromium profile and decodes the real WebM produced by MediaRecorder, including tab media, separate microphone audio, optional self-camera media, Range playback, playback-rate synchronization, capture offsets, and mixer volume.

Firefox and Safari are not part of the current viewer support contract until the same generated-media E2E matrix is run against them.

## CI contract

The sharing validation domain covers Worker/viewer typecheck, Worker tests, generated-viewer drift, deploy dry-run, a mock extension build wired to the local Worker, and the Drive-origin lifecycle E2E.

The vertical sharing test covers:

- OPFS→user-Drive publication;
- revision pinning and explicit reader permission;
- page closure while offscreen publication continues;
- committed-but-lost origin-response recovery after full Chrome restart;
- a >60-second delayed origin response;
- owner-session renewal;
- clean-browser viewer playback and Range reads;
- R2 read-through cache creation;
- revoke-before-Drive-cleanup ordering;
- delete/cache cleanup without deleting the user's Drive file;
- reuse of an already Drive-backed recording without another upload or owner-side media read.

The generic mock E2E excludes `@sharing-e2e`, so this slice runs with its required Worker/Drive relay environment only once. The required aggregate CI result remains `ci-gate`.

## Manual MVP acceptance

Run this sequence against staging before freezing a release:

1. Record a tab with separate microphone audio and, once, self-camera.
2. Publish an OPFS-backed recording. Confirm a user-owned Drive copy appears and publication completes after the Recordings page is closed.
3. Confirm the published Drive revision is pinned and only the configured service-account email has the added reader permission.
4. Quit Chrome during a resumable OPFS→Drive publication, reopen the same profile, and confirm publication recovers without creating a developer-owned media copy.
5. Publish a recording that is already backed by Drive. Confirm no second media file/upload is created for sharing.
6. Open the capability in a clean browser. Seek deeply, change playback speed and mixer volume, and verify transcript/topics/notations.
7. Confirm R2 contains only cache keys under `cache/v1/` for the new share and that the cache metadata has a fixed ~30-hour expiration.
8. Revoke the share. Confirm a fresh viewer manifest/media request is denied immediately, then confirm the service-account file permission is removed.
9. Use **Delete published data**. Confirm D1 publication/media-asset rows and cache objects are gone, the publication pin is released, and the user's Drive file still exists.
10. Confirm the hourly cleanup has no expired cache rows and required CI is green.

## Rollback

For an extension regression, roll back the extension build to the previous release/service-origin pair. Existing capabilities remain server-side.

For a Worker regression, redeploy the previous Worker version against the same D1/R2 resources. Do not destructively roll back D1 migrations; forward-fix schema changes.

During a capability-key incident, retain all keys still referenced by surviving shares while switching `CAPABILITY_KEY_ID` for new shares. During a session-key incident, rotate `SESSION_KEY` and expect active sessions to authenticate again.

During a sharing-reader credential incident, rotate the service-account key/Worker secret. Changing the service-account identity itself is a migration: existing published Drive files grant permission to the old email and must be republished or have permissions migrated by the owner extension before the old identity is disabled.
