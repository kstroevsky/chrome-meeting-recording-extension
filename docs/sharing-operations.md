# Sharing deployment and operations

This document is the MVP runbook for the sharing Worker and the extension build that points at it.

## Environments

`sharing-worker/wrangler.jsonc` defines three isolated environments:

- default: development, using `recording-extension-sharing-dev` and `recording-extension-sharing-media-dev`;
- `staging`: `recording-extension-sharing-staging`;
- `production`: `recording-extension-sharing`.

Before the first remote deployment, replace every placeholder D1 database id, extension origin, and Google OAuth client id with the real value for that environment. Keep D1 and R2 resources isolated between environments.

The extension must be built with the matching service origin:

```bash
SHARING_SERVICE_ORIGIN=https://sharing-staging.example.com npm run build
SHARING_SERVICE_ORIGIN=https://sharing.example.com npm run build
```

`SHARING_SERVICE_ORIGIN` must be a bare HTTPS origin. The Worker `ALLOWED_EXTENSION_ORIGINS` value must contain the exact extension origin that owns that build.

## Provisioning and deploy

From `sharing-worker/`, create the D1 database and R2 bucket for the target environment, copy the returned D1 id into `wrangler.jsonc`, then apply all migrations before deploying:

```bash
npx wrangler d1 create recording-extension-sharing-staging
npx wrangler r2 bucket create recording-extension-sharing-media-staging
npx wrangler d1 migrations apply recording-extension-sharing-staging --remote
npx wrangler deploy --env staging
```

Use the equivalent production resource names for production. Never point staging and production at the same D1 database or R2 bucket.

Run the deployment dry-runs before a real deploy:

```bash
npm run dry-run
npx wrangler deploy --env staging --dry-run
npx wrangler deploy --env production --dry-run
```

## Secrets and key rotation

Each environment needs:

- `SESSION_KEY`: signs short-lived owner and viewer sessions.
- `CAPABILITY_KEYS_JSON`: JSON keyring, for example `{"v1":"<secret>"}`.
- `CAPABILITY_KEY`: the pre-keyring secret while any migrated share still has `capability_key_id='legacy'`.

Set secrets with Wrangler for the intended environment, for example:

```bash
npx wrangler secret put SESSION_KEY --env production
npx wrangler secret put CAPABILITY_KEYS_JSON --env production
npx wrangler secret put CAPABILITY_KEY --env production
```

To rotate capability keys without invalidating existing links:

1. Add a new entry to `CAPABILITY_KEYS_JSON` while retaining every key id referenced by an existing share.
2. Deploy the expanded keyring.
3. Change `CAPABILITY_KEY_ID` to the new id and deploy again. New shares use the new key; existing shares keep their stored key id.
4. Check D1 before removing an old key:

   ```sql
   SELECT capability_key_id, COUNT(*) FROM shares GROUP BY capability_key_id;
   ```

5. Remove an old key only after no surviving share references it. Keep `CAPABILITY_KEY` until no `legacy` rows remain.

`SESSION_KEY` can be rotated directly. Existing owner/viewer sessions then fail and must be renewed; stored shares and capability links remain valid.

## Admission, quotas, and retention

Owner admission is based on Google token introspection and the configured `GOOGLE_OAUTH_CLIENT_ID`. The extension-origin allow-list is a CORS rule, not an authentication boundary.

Default limits are:

- 120 owner control-plane mutations per minute;
- 200 shares per owner;
- 500 GiB reserved/stored bytes per owner;
- 16 recordings per share and 3 tracks per recording;
- 100 GiB total published bytes per share;
- 8 MiB manifest request body;
- shared contract limits for titles, transcript segments/text, topics, spans, keywords, notations, and MIME/id lengths.

Draft/uploading shares older than 7 days are cleaned up. Revoked shares retain media for 30 days unless the owner explicitly uses **Delete published data** first. The scheduled Worker cleanup runs every six hours and aborts unfinished multipart uploads before deleting R2 objects and D1 metadata.

Changing retention or quota values is an operational policy change; update the Wrangler environment values and this runbook together.

## Revoke versus delete

**Revoke** invalidates future viewer access immediately and leaves published media retained according to the retention policy.

**Delete published data** revokes first if needed, aborts unfinished multipart uploads, removes completed R2 objects, deletes D1 upload/track/share metadata, and lets the extension clear its local publication state.

## Operational metrics

Cloudflare Worker observability is enabled. Structured events intentionally omit share ids, owner ids, capability URLs, auth headers/tokens, transcript contents, titles, and media object keys.

Monitor these event counters and fields:

- `sharing_publication_request_failed`: operation + HTTP status;
- `sharing_finalization_failed`: HTTP status;
- `sharing_upload_chunk_replayed`: bytes recovered from an idempotent retry;
- `sharing_storage_committed`: completed published bytes;
- `sharing_viewer_authorization_failed`: viewer surface + HTTP status;
- `sharing_cleanup`: deleted/failed cleanup counts;
- `sharing_cleanup_failed`: scheduled cleanup invocation failed;
- `sharing_request_failed`: unexpected top-level Worker failure + HTTP method.

Alert on sustained finalization failures, rising replay/retry rates, viewer authorization failures above the expected background level, cleanup failures, and storage growth that approaches the configured owner/service budget.

## Viewer support matrix

The owner extension remains Chrome/Chromium MV3-specific for the MVP.

The public viewer MVP support target is current Chromium-family desktop browsers. The sharing E2E suite opens a capability in a clean Chromium profile and decodes the real WebM produced by the extension's MediaRecorder, including tab audio/video, separate microphone audio, and optional self-camera media. It also verifies Range seeking, playback-rate synchronization, the +3.8 s auxiliary-track offset case, and the mixer.

Firefox and Safari are not part of the MVP support contract yet. Expanding the matrix requires running the same generated-media E2E against those engines and explicitly covering the optional MP4/M4A recording profiles before claiming support.

## CI contract

The existing `.github/workflows/ci.yml` contains a dedicated sharing gate. Ready PRs, merge queues, and `main` pushes run:

- Worker/viewer typecheck;
- Worker tests;
- generated viewer drift check;
- Worker deployment dry-run;
- a real mock-extension build wired to the local Worker;
- the sharing lifecycle E2E, including OPFS, Drive Range reads, page closure, full Chrome restart, upload-response loss, expired multipart recovery, session renewal, viewer playback, revoke, and permanent deletion.

Draft PRs run this gate only when sharing-related files change. The generic mock E2E job excludes `@sharing-e2e` so the sharing slice runs once with its required Worker environment.

## Manual MVP acceptance

Before freezing or releasing the sharing MVP, run this sequence against staging with a large recording:

1. Record a tab with separate microphone audio; include self-camera once as a separate check.
2. Start sharing and confirm visible per-track/total progress and a resumable state.
3. Close the Recordings page while media is still uploading; confirm Worker-side bytes continue to increase.
4. Quit Chrome completely, reopen the same profile, and confirm publication resumes from the durable offset rather than restarting from zero.
5. Open the capability URL in a clean browser profile. Seek deeply, change playback speed, change mixer volume, and verify transcript/topics/notations.
6. Reopen Recordings, open **Shared**, and confirm the server-side share is still discoverable without the creation dialog.
7. Revoke the share. Confirm a fresh manifest/media request loses access while R2 objects still exist.
8. Use **Delete published data**. Confirm the share, upload rows/parts/tracks, and R2 objects are gone.
9. Confirm the cleanup schedule has no stale multipart uploads or draft shares left outside the configured retention window.
10. Confirm the required CI result is green and the generated viewer has no diff.

Once this sequence passes, treat the sharing architecture as MVP-frozen. New expiration controls, link rotation UX, passcodes, invited-user ACLs, downloads, richer permissions, comments, and analytics belong in later product work.

## Rollback

For an extension regression, roll back the extension build to the previous `SHARING_SERVICE_ORIGIN`/release pair without changing stored capabilities.

For a Worker regression, redeploy the previous Worker version against the same D1/R2 resources. Do not roll back D1 migrations destructively. Forward-fix schema changes instead.

During a capability-key incident, keep all still-referenced old keys in the keyring while switching `CAPABILITY_KEY_ID` for new shares. During a session-key incident, rotate `SESSION_KEY` and accept that active sessions must authenticate again.
