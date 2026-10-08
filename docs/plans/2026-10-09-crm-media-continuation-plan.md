# CRM media continuation plan — verified 2026-10-09

## Scope and verdict

This is a continuation of PLAN C, M1–M6, in the CRM's
`docs/architecture/2026-10-07-meeting-recorder-integration-plan.md`, including its
current uncommitted corrections. It does not replace that architecture document
or change the owner's accepted decisions. This review changed no product code.

Phase 1 is deployed according to the owner. Local inspection confirms the events,
routing and receiver foundations exist. Production deployment and the Phase 1
joint gates were not independently re-run in this review.

Phase 2 has substantial foundations, but M1 is not operational and M2 is incomplete.
The next implementation slice should finish a tested additional CRM replica and
its safe playback/disconnect behavior. M3–M6 should follow only after those gates.

Reviewed extension HEAD: `4dd680c` on `feat/save-to-destinations`.
Reviewed CRM HEAD: `43ddd13d` on `codex/fix-retired-salary-index`.
The CRM plan already has user/session-owned changes; the extension has unrelated
untracked files. Preserve both and stage only the files belonging to each task.

## What already exists

| Area | Verified implementation | Remaining limit |
| --- | --- | --- |
| Generic protocol | Extension ADR-0009, capability parsing, same-origin HTTPS control plane, dedicated bearer credential | No independent receiver proof yet |
| Byte sources | `src/media/ArtifactByteSource.ts` and OPFS/Drive resolver; sharing uses the neutral abstraction | Downloads cannot supply upload bytes |
| CRM provider | Create/status/part/complete/playback endpoints; hash-only tokens; immutable create fingerprint; attempt-specific storage keys; provider ListParts and HEAD checks | Core service lacks dedicated lifecycle tests and deployment wiring |
| CRM limits | Connection throttle, four-upload cap, 32 MiB parts, 8 GiB artifact limit, 64 GiB connection quota | Limits are hardcoded and not disclosed before export; active-count query excludes completing attempts |
| CRM reconciliation | Dedicated multipart scan, pagination, grace period, stale aborts | No completed-object orphan report; aborts do not reconcile DB lifecycle/quota state |
| Extension executor | Durable multipart runner, provider-authoritative resume, bounded part concurrency, expired-attempt restart, ready marker awaiting acknowledgement | Instantiated only in tests; no production queue/coordinator |
| Extension playback | External history locations, player source resolution, background ownership and sender checks | No media-transfer path writes these locations; expiry recovery is limited |
| Save confirmation | Start-time stream identity; held routes; confirmation and skipped destinations; deletion forgets routing | Intents contain no explicit start-time permission to export media |

Primary committed foundations:

- Extension `6359597`: protocol, byte-source extraction, transfer store/runner.
- Extension `4dd680c`: credentials, host-permission setup, external playback.
- CRM `eb8b0916`: schema, private provider, playback endpoint, CSP.
- CRM `691dad53`: connection-scoped guards.
- CRM `43ddd13d`: stale multipart reconciliation.

## Findings and their consequences

### 1. M1 upload orchestration is absent — confirmed, high priority

`src/offscreen.ts` never constructs `ExternalMediaTransferRunner` or its store.
`BackgroundIntegrationRuntime.confirmRecordingRoutes()` releases event routes,
and runtime bootstrap reconciles events/sharing, but neither queues media.
Offscreen RPC and events have no external-transfer lifecycle commands. Therefore
the existing executor does not produce a CRM replica for a saved recording.

Implement a background eligibility/lifecycle coordinator and an offscreen durable
queue, rather than adding a long upload to the confirmation request.

### 2. Start-time media authorization needs its own durable snapshot — confirmed gap

`RecordingIntegrationIntentDestination` snapshots data policy and connection
version, but has no media-export authorization. Looking only at the destination's
current media capability would allow enabling media today to upload recordings
that started with an events-only connection. A later profile edit has the same
risk. This violates D93's start-time privacy ceiling.

Add explicit media-replica authorization to newly created intents, tied to the
chosen service and logical connection. Legacy intents default to no media export.
The confirmation dialog must disclose video plus data together when both go to
that service. One removal skips both. Credential rotation may repair credentials
for an already authorized receiver; replacing the receiver must not silently
retarget existing work.

### 3. CRM-user playback incorrectly depends on extension enablement — confirmed defect

`apps/api/src/integrations/meeting-recorder/media/recording-media-upload.service.ts:373`
checks `meetingRecorderConnections.enabled` in `playbackForCrm()` and returns 410
when disabled. PLAN C explicitly says CRM users retain playback through interview
RBAC after recruiter offboarding. Keep connection revocation on all bearer API
calls; authorize CRM-user playback independently through the recording's interview
scope and artifact ownership. Test both behaviors together.

Extension `IntegrationCoordinator.mediaClient()` also requires `enabled`, so
M2's separate Disable automation behavior requires a distinction between permission
to export new work and permission to play previously stored media.

### 4. Media schema rollout and schema verification are incomplete — confirmed

The media migration exists, but `.github/workflows/deploy.yml` and the production
DDL checker contain no reference to `2026-10-08_meeting_recorder_media.sql`.
Production schema application was not verified. New webhook discovery queries
the media-token columns, making DDL-before-new-API a compatibility requirement.

The schema test at `apps/api/src/database/meeting-recorder-schema.spec.ts:299`
checks the expanded Drizzle connection table against only the Phase 1 SQL and
fails on `media_token_hash`. Verify the migration chain, then exercise it twice
on an isolated PostgreSQL database. Preserve deployed Phase 1 SQL semantics;
do not fix the test by pretending that new columns existed in the deployed schema.

### 5. Core provider lifecycle/security coverage is missing — confirmed

The media directory has guard and reconciliation specs, but no dedicated upload,
storage or authentication service specs. Existing controller tests predominantly
exercise discovery; their green result does not prove multipart lifecycle safety.
`interview-recordings.controller.spec.ts:24` and `:47` also instantiate the
controller without its new media dependency and fail spec type checking.

### 6. Recovery needs durable identity, metadata and local ownership — confirmed gaps

The transfer store records remote recording ID and source key, but not an explicit
local recording/file mapping. The new queue needs that mapping to acknowledge
completion without guessing, including legacy OPFS keys. Generate an opaque transfer
ID once and atomically persist it under a unique logical artifact/destination key.
Do not generate a new ID on each confirmation, startup, retry or filename change.
Keep the original create metadata immutable once queued, even after a local rename.

Local-download history does not reliably contain media `bytes`: the offscreen
queue must inspect the retained File and obtain its actual positive size before
persisting the create request. Requiring pre-existing `history.files[].bytes`
would silently omit the primary M1 Local-download path.

The runner checks source size before replaying a ready marker. Recover a verified
ready result without requiring source bytes that may no longer be present. After
writing the external location, re-read history to prove the write succeeded:
`recordArtifactLocation()` silently ignores a deleted/missing row or file.

### 7. Provider/client recovery edge cases need tests and corrections

Confirmed implementation limitations:

- Client retry handles HTTP 429/5xx but immediately exits on fetch/network errors.
- Storage maps missing multipart uploads to generic 503; a provider-aborted upload
  can repeatedly fail resume instead of reaching the protocol's expired/recreate path.
- Server active-upload counting considers only uploading, excluding completing.
- Reconciliation aborts provider sessions without updating their database rows.
- No completed-object orphan report exists for obsolete completed attempts.
- A playback capability response is verified, but no actual ranged media read is
  made before the runner labels a copy playable.

Test recovery of stale completion leases, simultaneous create/complete/restart,
quota reservation/release, missing provider uploads, and object size mismatch.
Keep evidence-based fixes bounded; do not introduce automatic recording purge
before the separate retention decision. Part-size verification should use actual
provider part sizes; final total size alone cannot prove binding per-part sizes.

### 8. M2 playback/disconnect is only partly implemented — confirmed

The player permits one master-source refresh per open recording and does not
retain refresh handlers for auxiliary microphone/camera tracks. Test repeated
expiry, seeking, restoration of playing/paused state and auxiliary synchronization
in Chromium. For M1, preserve OPFS-first and existing storage preference; implement
primary-external-before-Drive-backup ordering with general profiles later.

Integration deletion immediately removes credentials. There is no whole-library
affected-recording count or separate automation-disable action. Counts must use
unique live recording IDs and all pages: `RecordingHistoryService.list()` returns
only the first page (default 50). A Downloads copy alone is not playable inside
the extension and must not hide the disconnect consequence.

## Implementation sequence and commit boundaries

Each numbered slice is independently reviewable and should receive focused tests
and a meaningful commit. A slice may need a separate test commit where CRM's
AutoTest ownership requires it. Keep both repositories' commits separate.

### A. Establish a deployable, tested CRM provider

1. **CRM schema and deployment wiring.** Repair migration-chain tests; add media
   schema invariants; wire SQL copying, execution ordering and DDL validation.
   Validate clean install and Phase 1 upgrade, repeat application, unique transfer
   identity, foreign keys, checks and indexes on an isolated database.
2. **CRM auth/playback correction.** Fix CRM-user playback after connection disable;
   test revoked/replaced bearer tokens, cross-connection artifact rejection,
   interview RBAC and ADMIN-only unmatched access. Correct controller spec setup.
3. **CRM multipart lifecycle.** Add service/storage tests, then fix confirmed
   failures: create deduplication/conflict, attempt replacement, completion lease,
   lost complete reply, HEAD mismatch, paginated ListParts, missing provider session,
   exact part sizes, active cap and quota transitions. Expose consistent typed
   media responses/errors through shared schemas for CRM consumers.
4. **CRM media reconciliation.** Reconcile stale provider and database states;
   make missing-session aborts convergent; report completed orphan objects after a
   grace period with redacted output and dry run. Keep document reconciliation
   restricted to its existing prefixes. Defer recording-retention purge policy.

Proposed commits: `fix(meeting-recorder): verify and wire media schema rollout`,
`fix(meeting-recorder): preserve CRM playback after connection disable`,
`fix(meeting-recorder): harden multipart lifecycle recovery`,
`feat(meeting-recorder): reconcile media attempts and report orphan objects`.

### B. Finish extension M1 as an additional replica

5. **Start-time media intent.** Snapshot media permission and logical receiver
   identity at Start; migrate legacy intents conservatively; disclose media in the
   existing confirmation row; confirm/skip media and data atomically. Establish
   an eligibility API over persisted intent/stream/history, not current profiles.
   Require capture finalization and sealed media ownership, not merely a transient
   history `complete` value while files are still being added. Eligibility excludes
   notes/transcript sidecars and preserves the tab/mic/self-video role mapping.
6. **Durable offscreen queue.** Add explicit local recording/file IDs, a unique
   logical queue key and opaque persistent transfer ID; preserve immutable request
   metadata; validate the OPFS File and MIME/role mapping; reuse the byte-source
   abstraction. Support queued/running/retry/action-required/ready outcomes with
   bounded redacted errors and timestamps. Initially run one artifact transfer at
   a time globally: the runner's 256 MiB ceiling is per transfer, so unrestricted
   parallel transfers would multiply it. Improve concurrency only with a shared
   global byte budget and destination cap.
7. **Background/offscreen lifecycle.** Add short RPCs for enqueue, work snapshot,
   recovery, acknowledgement and local cancellation. Persist before returning an
   enqueue acknowledgement; do network work asynchronously. Reconcile on save
   confirmation, final history change, startup and offscreen reconnect; schedule
   retries through durable state and alarms. Replay ready results on reconnect.
   Include queued/running/unacknowledged external work in offscreen update/close
   protection. Source bytes and secrets must not travel through large RPC payloads.
8. **Commit completion safely.** Validate local owner and released intent again;
   write `ArtifactLocation.external`; prove it was durably written; acknowledge
   idempotently. Recovery first reconciles ready journals with existing locations,
   then discovers missing transfers. Deletion cancels local work and cannot
   resurrect history; cancellation never deletes a CRM recording or media object.
9. **Credentials and user recovery.** Authorize each offscreen job through the
   trusted background boundary. Prefer background-mediated small control-plane
   calls with direct offscreen signed PUTs, or a narrowly scoped ephemeral credential
   grant over the trusted Port; do not add a popup/content-readable credential API.
   Revalidate destination state and granted upload origins on resume/rotation.
   Use one host-permission pattern converter for settings and runtime checks,
   including non-default ports and IPv6; enforce the exact signed URL origin
   separately. Add direct `ExternalMediaClient` tests for these trust boundaries,
   which the current mock-runner tests do not cover. Validate persisted job shapes
   and use keyed IndexedDB access/transactions for queue identity and updates.
   Display progress, retained-local failure, source-unavailable and explicit Retry.
   Keep tokens only in the designated secret store, and signed URLs only in memory.

Proposed commits: `feat(media): snapshot replica authorization at recording start`,
`feat(media): add durable offscreen transfer queue`,
`feat(media): reconcile confirmed replicas with recording history`,
`feat(media): expose replica progress and recovery`.

M1 acceptance: confirming a newly authorized recording sends tab/mic/camera media
from retained OPFS to the intended external stream, preserves Downloads/Drive and
OPFS, stores one external location per destination/artifact, and survives worker
or offscreen restart. No held, skipped, deleted, legacy-unconsented or retrospectively
retargeted recording uploads. Missing local bytes produce a visible recoverable
condition. Events remain independent of video latency; they must not advertise a
remote media copy as ready before actual completion.

### C. Complete M2 and the CRM media UI before exposing remote dependence

10. **Safe disable/disconnect.** Separate automation state from retained playback
    credentials. Disable stops new/pending exports but preserves extension playback;
    CRM-side disable still revokes bearer access. Disconnect counts all affected
    live recordings, explains loss of extension playback, confirms that consequence,
    stops local work, then removes credentials safely. Removing an extension entry
    preserves CRM data/media. Remote deletion remains deferred pending a capability.
11. **Playback and explicit space release.** Refresh master and auxiliary URLs
    repeatedly with bounded recovery; restore position and play/pause state after
    metadata readiness. Offer Free up space only after actual remote playback is
    verified. Respect playback/transfer leases; maintain a durable release marker
    so OPFS/history reconciliation cannot re-adopt deliberately released files.
    Test every delete/write/crash boundary. Keep OPFS by default.
12. **CRM provisioning and player.** Add the ADMIN one-time media-token issue/replace
    UI and typed client calls. Expose ready media descriptors by connection plus
    external recording ID, since Phase 1 snapshots contain no external artifact IDs.
    Add a native ranged player in recording details with expiry refresh and RBAC.
    Ensure playback query URLs and token responses are excluded from query/storage
    persistence, logs, analytics and crash capture. Follow the CRM's design,
    i18n, responsive and security-review requirements.

These are separate commits for disconnect semantics, playback/release, shared/API
descriptors, provisioning UI and recording player. Do not treat the existing
backend endpoint or jsdom tests as a completed CRM browser player.

### D. Continue M3–M6 only after the replica/playback gates

| Milestone | Work and prerequisite | Acceptance |
| --- | --- | --- |
| M3 | Generalize profile normalizers/settings/UI to local or Drive media plus several data routes; retain V1 settings | Existing profiles survive, built-ins retain behavior, edits cannot expand historical export permissions |
| M4 | Allow end-dialog destination changes before third-party release; explicitly record the final user decision within the original privacy ceiling | Changing/removing a service does not leak video or data to the previous target; unanswered dialog stays held; local/Drive starts promptly |
| M5 | Introduce a real external primary-media delivery state, rather than treating external mode as local fallback | Success/failure reflects remote ownership; recovery stays in OPFS; no mandatory Downloads/Drive; safe playback and explicit release already proven |
| M6 | Publish normative generic protocol and a small independent receiver with conformance harness | JM0–JM6 pass against that receiver with no extension-specific provider code; JM12 closed |

M4 must not silently add a new receiver outside the Start-time ceiling. A new
receiver needs an explicit reviewed authorization flow, rather than a later
settings edit. Optional Drive backup and one-time pairing codes are later work.

## Verification and release gates

| Gates | Required evidence |
| --- | --- |
| JM0 | Real signed discovery, HTTPS/same-origin rejection tests, storage permission grant from a user gesture |
| JM1 | Real Chrome → presigned R2 UploadPart → complete/HEAD → ranged playback; no emulator substitute |
| JM2–JM5 | At least 1 GiB file, exact part lengths, process termination/restart, expired URL renewal, expired attempt replacement with one artifact ID |
| JM6–JM7 | Chromium playback over more than one expiry, seeking/auxiliary tracks, CRM native Range requests, no CSP violation |
| JM8, JM13 | HTTP-level connection isolation, token replacement/disable, interview RBAC, ADMIN-only unmatched, CRM playback preserved after extension disable |
| JM9–JM11 | Count beyond 50 recordings, disable vs disconnect, local removal preserves remote media, verified explicit release and crash recovery |
| JM12 | Independent reference receiver; reserved for M6 |
| JM14–JM16 | Role/MIME/filename negative cases, stored allowlisted type, ID-only keys/headers, unsupported upload parameters rejected before reading bytes |
| JM17–JM18 | Document prefix isolation, stale upload cleanup and DB convergence, orphan report, connection throttle and fifth-upload rejection including completing work |
| JM19 | One end-dialog removal suppresses both media and events, including delayed/restarted work |

JM1 needs a private test bucket or isolated prefix and dedicated test connection,
not a recruiting recording. Record build/commit versions, byte counts, part counts,
status codes and sanitized results. Do not save raw tokens, URLs, browser traces
with signed queries, or real meeting content. Validate CORS/ETag exposure and
Chrome optional host permissions independently; actual extension requests must
prove their browser behavior. The CRM player needs its own CORS/CSP check.

Cloudflare currently documents that expired signed responses omit CORS headers:
browser fetch may expose a network error rather than a readable 403. The client
must support bounded network-failure recovery and fresh signing, not only a 403
branch. Primary sources checked on 2026-10-09:

- https://developers.cloudflare.com/r2/buckets/cors/
- https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- https://developers.cloudflare.com/r2/api/s3/api/

The plan's real-R2 presigned UploadPart gate remains necessary. Documentation
and SDK support do not prove this application's full browser path works.

## Fresh checks performed

Environment: installed Node 22.22.0 and dependencies; CRM supports Node 22.
Extension declares Node >=24, so its release build/CI must also verify Node 24.

| Check | Result |
| --- | --- |
| Extension `npm run typecheck` | Pass |
| Extension six focused routing/media/settings/background suites | 69 tests passed |
| Extension six source resolver/player/removal/webhook/contract suites | 56 tests passed; jsdom reports unsupported media-element methods, so this is not browser playback proof |
| Extension `npm run check:background-architecture` | Pass; 111 production background files |
| CRM API focused meeting-recorder + schema Vitest run, `DATABASE_URL=` | 136 tests passed, one schema-chain test failed; DB integration specs structurally excluded |
| CRM API `tsc --noEmit` | Pass |
| CRM shared meeting-recorder/error schemas | 48 tests passed |
| CRM web meeting-recorder API spec | One test passed; existing Phase 1 API coverage |
| CRM API `tsc --noEmit -p tsconfig.spec.json` | Fail: 1,161 diagnostics repository-wide, including two old-constructor calls in interview-recordings specs |

The broad spec diagnostics are outside the bounded media review; do not claim all
are caused by Phase 2 or all are pre-existing without a baseline comparison.
The two controller constructor failures directly match the changed constructor.
No PostgreSQL integration tests, production schema inspection, real R2 transfers,
browser E2E, deployment or security-review verdict were completed here.

Exact suite selections:

```text
Extension run 1:
src/offscreen/media
src/integrations/__tests__/IntegrationCoordinator.test.ts
src/integrations/__tests__/RecordingRoutingService.test.ts
src/settings/__tests__/IntegrationSettingsController.test.ts
src/background/messaging/__tests__/playbackMessages.test.ts
src/background/playback/__tests__/RecordingPlaybackService.test.ts

Extension run 2:
src/integrations/__tests__/WebhookTransport.test.ts
src/media/__tests__/ArtifactByteSourceResolver.test.ts
src/recordings/player/__tests__/playbackSource.test.ts
src/recordings/player/__tests__/PlayerController.test.ts
src/background/messaging/__tests__/libraryMessages.remove.test.ts
src/integrations/__tests__/contractFixtures.test.ts

CRM:
DATABASE_URL= pnpm --filter @crm/api exec vitest run \
  src/integrations/meeting-recorder src/database/meeting-recorder-schema.spec.ts --maxWorkers=2
pnpm --filter @crm/api exec tsc --noEmit
pnpm --filter @crm/shared exec vitest run \
  src/schemas/meeting-recorder.spec.ts src/schemas/api-errors/meeting-recorder.spec.ts
pnpm --filter @crm/web exec vitest run app/lib/meeting-recorder-api.spec.ts
pnpm --filter @crm/api exec tsc --noEmit -p tsconfig.spec.json
```

## Delivery rules and unresolved decisions

Use a dedicated `codex/` branch/worktree for subsequent CRM work after selecting
the correct baseline; do not mix Phase 2 with the unrelated salary-fix branch.
Respect the CRM full development/review track for migrations, auth, RBAC, tests
and UI. Security-reviewer is required for the media API/credential changes.
Each commit should name the behavior and carry verified acceptance criteria;
CRM commits require the repository's `ac_verified:` convention. Keep checks and
fixtures with the behavior they prove, and explicitly stage the intended files.

The current 8 GiB per-artifact and 64 GiB per-connection constants are implementation
defaults, not a substitute for O11's storage-cost decision or user disclosure.
Keep a conservative configurable default for development, disclose it before
media confirmation, and resolve production limits before rollout. O3's recording
retention/purge policy remains separately unresolved; receipt retention is already
a different implemented job. Do not add automatic media deletion under that job.

The first implementation work should be A1/A2 in CRM and B5 in the extension,
followed by the provider lifecycle tests and durable queue. Prepare a reviewable
staging migration/CORS plan and the real-R2 harness before changing external
infrastructure. Only mark a milestone complete when its relevant gates have fresh
evidence; a commit or unit-test pass alone is insufficient.
