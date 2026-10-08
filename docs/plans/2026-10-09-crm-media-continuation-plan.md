# CRM media continuation plan — verified 2026-10-09

Revision 2: findings rechecked with the current classes and an in-process HTTP
probe; CORS assumptions corrected; dependencies, recovery states and release
boundaries made explicit. Revision 1 is preserved in commit `d0b2144`.

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
| Generic protocol | Extension ADR-0009, capability parsing, same-origin HTTPS control plane, dedicated bearer credential | No independent receiver proof; large valid part manifests exceed the client's current response bound |
| Byte sources | `src/media/ArtifactByteSource.ts` and OPFS/Drive resolver; sharing uses the neutral abstraction | Downloads cannot supply upload bytes |
| CRM provider | Create/status/part/complete/playback endpoints; hash-only tokens; immutable create fingerprint; attempt-specific storage keys; provider ListParts and HEAD checks | Core service lacks dedicated lifecycle tests and deployment wiring |
| CRM limits | Connection tracking within each handler, upload-count check, 32 MiB parts, 8 GiB artifact limit, 64 GiB connection quota | 600/min budget is per handler, not shared across media endpoints; count excludes completing attempts; storage limits are hardcoded and undisclosed |
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

This is a required design constraint for the missing scheduler, not evidence of
an existing retroactive upload: no production media scheduler exists yet.

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
- A stored completing upload can stall indefinitely: CRM status returns 409 even
  after its two-minute completion lease has expired; the runner exits on 409 and
  never reaches the create/complete paths that can recover it. Repeated invocation
  follows the same path. Define a bounded completing/reconciliation response;
  do not retry every 409 indiscriminately, since immutable-create conflicts are final.
- Storage maps missing multipart uploads to generic 503; a provider-aborted upload
  can repeatedly fail resume instead of reaching the protocol's expired/recreate path.
- Server active-upload counting considers only uploading, excluding completing.
- Reconciliation aborts provider sessions without updating their database rows.
- No completed-object orphan report exists for obsolete completed attempts.
- A playback capability response is verified, but no actual ranged media read is
  made. Distinguish storage-ready plus capability-issued from browser-playback-
  verified. HEAD plus a valid capability can register an M1 replica while OPFS is
  retained; it cannot by itself close JM1/JM6 or authorize Free up space.

Test recovery of stale completion leases, simultaneous create/complete/restart,
quota reservation/release, missing provider uploads, and object size mismatch.
Keep evidence-based fixes bounded; do not introduce automatic recording purge
before the separate retention decision. Part-size verification should use actual
provider part sizes; final total size alone cannot prove binding per-part sizes.

Do not automatically free an artifact's quota merely because one multipart
attempt was aborted. Artifact identity and upload attempts are separate: a later
attempt can finish the same artifact. Specify reservation release/reacquisition,
late completion and orphan-object handling together; failed-to-upload does not
authorize deleting an existing ready CRM recording.

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

### 9. The media request budget is split across handlers — reproduced defect

`recording-media-guards.ts` overrides `getTracker()` but inherits the Nest
throttler's `generateKey()`, which includes controller and handler names. A
two-handler HTTP probe with a limit of two accepted `a,a,b,b` (all 200), then
rejected a third `a` (429). Thus the current implementation does not enforce
D92's shared 600 requests/minute per connection across media API calls. The
existing guard spec proves token sharing on one handler, not across handlers.

Give the media guard its own namespaced aggregate key based on connection and
throttler policy, independent of handler. Preserve the separate global perimeter
guard. Test alternating endpoints, different tokens for the same connection,
different connections, and invalid/disabled credentials before bucket charging.

### 10. Update/reload protection has two independent callers — confirmed seam

Protecting `OffscreenEventRouter.hasBackgroundWork` alone is insufficient:
`CriticalWorkCoordinator.applyUpdateWhenSafe()` can call runtime reload directly.
Its current work predicate and freshness probe cover recording/Drive/analysis,
but not external media. Extend both this coordinator and offscreen host cleanup.
At startup/reconnect, an unknown external-work snapshot must not be interpreted
as idle. Durable retry/action-required jobs need not block updates forever;
active uploads, in-flight acknowledgements and unknown live work do block them.

### 11. The generic client cannot consume all allowed part manifests — reproduced

`ExternalMediaClient` bounds every JSON response at 64 KiB. A valid synthetic
2,000-part status with 32-character quoted ETags is 130,990 bytes and is rejected
as `Media response too large`. This does not block the current CRM's 8 GiB /
32 MiB profile (at most 256 parts), but conflicts with the generic protocol's
10,000-part range and other supported part-size choices. Add count-aware bounded
manifest parsing with explicit ETag/response limits, or define a compatible
pagination contract before claiming general receiver conformance. This is a
bounded client change; do not rewrite the protocol without contract review.

## Evidence grading and corrected assumptions

The highest-confidence findings above come from executable probes or directly
reachable source paths. Missing production orchestration is an implementation
gap; start-time consent and future disconnect counts are constraints on new work.
Provider lock races, quota release semantics and repeated media playback still
need their specific database/browser reproductions before prescribing a fix.

- **Deployment:** absent checked-in wiring is confirmed; an unapplied live schema
  is not. A manually applied production migration would not remove the need for
  repeatable deployment wiring. No live database was inspected.
- **Capability authenticity:** the outgoing test event is Standard Webhooks
  signed. The capability response is HTTPS JSON and validated as untrusted data;
  there is no separate response-signature scheme in the implemented protocol.
- **CORS:** ordinary CRM web-page requests and privileged extension-origin
  requests are different. Granted host permissions carry into the offscreen
  document. Do not assume an R2 response lacking CORS headers is unreadable by
  this extension; prove the actual privileged path in JM1/JM4. Bounded network
  retries remain necessary for offline/transient failures independently of CORS.
- **Remote readiness:** obtaining a playback URL does not prove media playback,
  but absence of a browser read is not an upload-completion defect by itself.
- **Scope:** orphan-object reporting, repeated playback and general manifests
  are separate acceptance items; do not expand them into unrelated retention,
  player redesign or repository-wide spec repair.

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
   In a separate focused commit, make the media rate budget aggregate across
   handlers and add the alternating-endpoint regression test described in finding 9.
3. **CRM multipart lifecycle.** Add service/storage tests, then fix confirmed
   failures: create deduplication/conflict, attempt replacement, completion lease,
   lost complete reply, HEAD mismatch, paginated ListParts, missing provider session,
   exact part sizes, active cap and quota transitions. Resolve the reproduced
   completing/409 dead end with an explicit server/client recovery contract.
   Keep immutable-create 409 final; distinguish it from a transient completion
   lease. Add bounded request deadlines and abort handling so retry can make
   progress after a stalled request rather than waiting without limit.
4. **CRM media reconciliation.** Reconcile stale provider and database states;
   make missing-session aborts convergent; report completed orphan objects after a
   grace period with redacted output and dry run. Keep document reconciliation
   restricted to its existing prefixes. Defer recording-retention purge policy.

Proposed commits: `fix(meeting-recorder): verify and wire media schema rollout`,
`fix(meeting-recorder): preserve CRM playback after connection disable`,
`fix(meeting-recorder): share media rate limits across endpoints`,
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
   Extend both the offscreen host and `CriticalWorkCoordinator`: active transfer
   and completion handoff block reload, and an unknown live-work snapshot is
   conservatively busy. Persisted paused/retry/action-required rows alone do not
   block updates indefinitely. Quiescent ready journals must survive a deliberate
   close and replay on restart. Source bytes never travel through RPC payloads.
8. **Commit completion safely.** Validate local owner and released intent again;
   write `ArtifactLocation.external`; prove it was durably written; acknowledge
   idempotently. Recovery first reconciles ready journals with existing locations,
   then discovers missing transfers. Deletion cancels local work and cannot
   resurrect history; cancellation never deletes a CRM recording or media object.
9. **Credentials and user recovery.** Use an ephemeral job grant over the existing
   trusted offscreen Port as the default implementation: background resolves
   credentials and validates the job's recorded owner/intent; offscreen runs the
   existing client and data-plane executor directly. Obtain fresh authorization
   on resume and credential renewal; discard grant secrets on cancellation or
   connection change. The offscreen runtime cannot call `chrome.permissions`,
   so permission checks remain in background. Define typed offscreen-only grant
   requests, separate from popup messages, that accept a job identity rather than
   an arbitrary URL or unverified destination. Do not expose credential reads to
   settings, player or content-script senders. A grant is memory-only and contains
   only the configured endpoint, validated capability and authorized bearer.
   Revalidate the job before control-plane operations, including part signing
   and completion, so a grant obtained at job start cannot authorize the whole
   transfer after disable/removal. Revocation handling aborts live part requests.
   Revalidate destination state and granted upload origins on resume/rotation.
   Use one host-permission pattern converter for settings and runtime checks,
   including non-default ports and IPv6; enforce the exact signed URL origin
   separately. Add direct `ExternalMediaClient` tests for these trust boundaries,
   which the current mock-runner tests do not cover. Validate persisted job shapes
   and use keyed IndexedDB access/transactions for queue identity and updates.
   Display progress, retained-local failure, source-unavailable and explicit Retry.
   Keep tokens only in the designated secret store, and signed URLs only in memory.

The grant transport needs rejection tests for spoofed Ports, wrong local file or
destination, deleted/skipped intents and revoked host permissions. Background
must verify canonical ownership rather than trusting arbitrary fields from a queue
row. An already in-flight PUT or issued signed URL cannot be promised to disappear
instantaneously on disable; abort local work and refuse subsequent grants/calls.
Do not add a credential-bearing generic fetch proxy.

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
    This is a separate submilestone after safe M2 playback. It is not needed to
    demonstrate an additional M1 copy; M1 has no space-release operation.
12. **CRM provisioning and player.** Add the ADMIN one-time media-token issue/replace
    UI and shared validated schemas/typed client calls. Expose ready media descriptors by connection plus
    external recording ID, since Phase 1 snapshots contain no external artifact IDs.
    Add a native ranged player in recording details with expiry refresh and RBAC.
    Ensure playback query URLs and token responses are excluded from query/storage
    persistence, logs, analytics and crash capture. Follow the CRM's design,
    i18n, responsive and security-review requirements.

These are separate commits for disconnect semantics, playback, explicit release, shared/API
descriptors, provisioning UI and recording player. Do not treat the existing
backend endpoint or jsdom tests as a completed CRM browser player.

### D. Continue M3–M6 only after the replica/playback gates

| Milestone | Work and prerequisite | Acceptance |
| --- | --- | --- |
| M3 | Generalize profile normalizers/settings/UI to local or Drive media plus several data routes; retain V1 settings | Existing profiles survive, built-ins retain behavior, edits cannot expand historical export permissions |
| M4 | Allow end-dialog destination changes before third-party release; record intentional new authorization explicitly | Changing/removing a service does not leak video or data to the previous target; settings edits cannot expand consent; unanswered dialog stays held; local/Drive starts promptly |
| M5 | Introduce a real external primary-media delivery state, rather than treating external mode as local fallback | Success/failure reflects remote ownership; recovery stays in OPFS; no mandatory Downloads/Drive; safe playback and explicit release already proven |
| M6 | Publish normative generic protocol and a small independent receiver with conformance harness | JM0–JM6 pass against that receiver with no extension-specific provider code; JM12 closed |

M4 must distinguish an intentional destination change in the end dialog from an
unrelated profile/settings edit. An explicit user decision may authorize a new
receiver: atomically skip the old receiver, create the new intent and stable
stream, and hold the new export until its confirmation is recorded. Do not impose
an absolute ban on new receivers at the end dialog, which would defeat M4. The
flow must disclose new video/data export and avoid duplicate release under stale
dialog messages. Optional Drive backup and one-time pairing codes are later work.

## Dependency graph and bounded implementation slices

CRM and extension work can advance independently until integration. The order
above is not a requirement to finish every CRM maintenance/UI task before building
the extension. Work against the existing normative ADR first and agree only the
specific recovery/limits amendments needed by the reproduced failures.

| Slice | Depends on | Concrete completion evidence |
| --- | --- | --- |
| P0: CRM schema wiring and migration tests | Existing Phase 1 schema | Fresh install and Phase 1 upgrade both pass; a second apply is harmless; workflow checker requires media DDL before new API |
| P1: CRM playback/aggregate throttle fixes | P0 for DB-backed validation | CRM users retain RBAC access after disable; bearer calls revoke; alternating media endpoints share one quota |
| P2: provider recovery contract and lifecycle tests | P0; extension review of wire semantics | Status/complete/create converge after ambiguous completion, missing provider session and expired lease; hard conflicts stay final |
| E0: start-time media intent | ADR and current routing | Legacy/no-media/held/skipped cases export nothing; one confirmation controls video and data |
| E1: durable queue and trusted grants | E0; agreed P2 wire semantics (provider coding may proceed separately) | Concurrent enqueue creates one ID; immutable metadata survives rename; source size comes from actual File; grants never persist |
| E2: lifecycle/history/update integration | E1 | Crash at each journal/history/ack boundary converges; both reload callers honor active/unknown work; deletion cannot recreate history |
| E3: progress/retry and safe disconnect | E2; P1 | Errors preserve source; library >50 is counted; disable preserves playback; disconnect requires the stated consequence to be confirmed |
| C0: CRM token UI, media descriptors and player | P1/P2 | ADMIN provisioning, scoped descriptor read, real ranged playback and refresh without persisted capabilities |
| R0: real-R2 replica/playback pilot | P0/P1/P2/E2/E3/C0; cleanup safety | JM0–JM10 and JM13–JM19 evidence relevant to M1/M2; no source release; JM2 uses >=1 GiB |
| R1: explicit space-release submilestone | R0 plus lease/release journal | Actual remote playback verified; deliberate release survives crashes/reconciliation; JM11 closed |
| Later M3/M4/M5/M6 | M1/M2 gates; R1 before sole-copy dependence | General profiles and deliberate end changes; real external delivery state; independent receiver JM12 |

The existing multipart reconciler can support an isolated R0 pilot after its
abort/missing-session safety is tested. Completed-object reporting and quota-state
convergence must be ready before broad rollout; they do not block local queue work.
Full recording-retention purge remains outside this rollout pending O3.

### Queue contract and recovery invariants

Persist a unique logical key containing local recording ID, file ID, destination
ID and authorized receiver generation; allocate one opaque transfer ID under that
key in an IndexedDB transaction. Never send the local IDs to the receiver. The
request uses the persisted stream's external recording ID and original sanitized
create metadata. A token refresh for the same receiver does not allocate a new
logical transfer; a newly authorized receiver uses a new identity.

Suggested states, as an implementation design rather than an existing wire change:

```text
queued -> uploading -> verifying-capability -> ready-unacknowledged -> acknowledged
              |                    |
              +-> retry-wait <------+       (transient, bounded, durable nextAttemptAt)
              +-> action-required          (credential/permission/source/hard conflict)
any unfinished job -> canceled             (removed recording or authorization)
```

`ready-unacknowledged` retains the remote artifact even without local source
bytes. `acknowledged` may remove the queue row only after the exact external
location is durable; acknowledgement is idempotent. Cancellation is distinct from
successful acknowledgement and is not remote deletion. Acquire source-use leases
only for live reads; a missing source cannot block replay of an already ready result.

Recover through keyed, coalesced operations. Reconcile durable ready results before
discovering new work; check existing locations before enqueue; permit only one
executor per logical key; allocate/compare immutable metadata atomically. Do not
run network requests inside IndexedDB transactions. History and queue cannot share
one transaction, so test convergence at each boundary instead of claiming atomicity.

Use durable `nextAttemptAt` and alarms for retry, jitter/backoff for transient
failure, bounded completing recovery, and fixed error categories without signed
URLs. Respect 429 timing where available. Stop retries on abort, revoke or hard
create conflict. Jobs waiting for credentials/source remain visible and retryable
without continuously keeping the service worker or offscreen runtime alive.

### Required failure-injection matrix

| Boundary | Expected recovery |
| --- | --- |
| Confirmation commits, enqueue never happens | Startup finds the authorized released intent and queues once |
| Queue commits, enqueue response is lost | Duplicate enqueue returns the original transfer ID and request |
| Part reaches provider, local receipt is lost | ListParts wins; that part is not needlessly uploaded again |
| Completion reply is lost | Reconcile provider HEAD/status; retain same artifact ID |
| Completing lease expires without an object | Contract reaches bounded complete/recreate recovery, not endless 409 |
| Ready journal commits, event is lost | Reconnect replays without reading source bytes |
| History location commits, ACK is lost | Existing exact location is recognized; ACK succeeds idempotently |
| Recording is deleted during upload/handoff | Abort local work, cancel journal, do not recreate history or delete remote media |
| Local name changes after enqueue | Original request fingerprint stays unchanged; title updates remain event work |
| Media enabled or profile changed after Start | No new historical media export absent an explicit new user decision |
| Update arrives during transfer | Both runtime-reload and offscreen-close paths defer or use a proven quiescent durable handoff |
| One source is deliberately released | Playback/transfer leases and release journal prevent unsafe deletion/re-adoption |

## Verification and release gates

| Gates | Required evidence |
| --- | --- |
| JM0 | Signed test request and strictly validated HTTPS capability response, same-origin rejection tests, storage permission grant from a user gesture |
| JM1 | Real Chrome → presigned R2 UploadPart → complete/HEAD → ranged playback; no emulator substitute |
| JM2–JM5 | At least 1 GiB file, exact part lengths, process termination/restart, expired URL renewal, expired attempt replacement with one artifact ID |
| JM6–JM7 | Chromium playback over more than one expiry, seeking/auxiliary tracks, CRM native Range requests, no CSP violation |
| JM8, JM13 | HTTP-level connection isolation, token replacement/disable, interview RBAC, ADMIN-only unmatched, CRM playback preserved after extension disable |
| JM9–JM11 | Count beyond 50 recordings, disable vs disconnect, local removal preserves remote media, verified explicit release and crash recovery |
| JM12 | Independent reference receiver; reserved for M6 |
| JM14–JM16 | Role/MIME/filename negative cases, stored allowlisted type, ID-only keys/headers, unsupported upload parameters rejected before reading bytes |
| JM17–JM18 | Document prefix isolation, stale upload cleanup and DB convergence, orphan report, aggregate connection throttle across all handlers and fifth-upload rejection including completing work |
| JM19 | One end-dialog removal suppresses both media and events, including delayed/restarted work |

JM1 needs a private test bucket or isolated prefix and dedicated test connection,
not a recruiting recording. Use a synthetic playable WebM/MP4 for browser playback
and a >=1 GiB byte-range fixture for the large transfer gate; padded invalid media
is not proof of playback. Record build/commit versions, byte counts, part counts,
status codes and sanitized results. Do not save raw tokens, URLs, browser traces
with signed queries, or real meeting content. Validate CORS/ETag exposure and
Chrome optional host permissions independently; actual extension requests must
prove their browser behavior. The CRM player needs its own CORS/CSP check.

Cloudflare documents missing CORS headers on expired signed responses for ordinary
web requests. Chrome documents privileged cross-origin extension requests and
permission inheritance into offscreen documents. Therefore test the paths
separately: extension host permission plus readable ETag/expiry behavior; CRM
native playback plus any CORS-dependent fetches and CSP. Generic network errors
still require bounded retry. Neither host permission nor CORS proves a signed URL
is trusted; retain exact HTTPS origin validation. Primary sources checked:

- https://developers.cloudflare.com/r2/buckets/cors/
- https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- https://developers.cloudflare.com/r2/api/s3/api/
- https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- https://developer.chrome.com/docs/extensions/reference/api/offscreen

The plan's real-R2 presigned UploadPart gate remains necessary. Documentation
and SDK support do not prove this application's full browser path works.

## Fresh checks performed

The suite results below are the initial review's 2026-10-09 baseline, not new
coverage created by this document. Revision 2 adds the focused probes in the
subsection below; all product source remains unchanged.

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

### Revision 2 executable rechecks

No source/spec files were added or changed. Temporary Node harnesses transpiled
the existing TypeScript classes using installed TypeScript. All credentials,
IDs, URLs and byte sources were synthetic; fetch/provider/DB behavior was injected,
and no network or database writes were made. The throttle probe used a real
Nest/Fastify in-process app with the production guard classes and two handlers.
These are bounded reproductions, not a substitute for committed regression tests.

| Scenario | Observed result | Evidence limit |
| --- | --- | --- |
| Network failure during create | One create call, then TypeError; no retry | Actual runner with injected network failure |
| Ready journal plus missing/zero-size source | Source-size rejection before ready replay; journal remains | Actual runner/store, in-memory storage adapter |
| CRM-user playback with disabled connection | 410 `MEDIA_CONNECTION_DISABLED` | Actual service, injected disabled connection row; controller RBAC tested separately later |
| Completing upload ten minutes after update, HEAD missing | Status still 409 `MEDIA_UPLOAD_COMPLETING` | Actual service path with injected attempt and missing object; no lock/concurrency proof |
| Runner resumes upload whose status is 409 | One status call; zero create/complete calls; exits | Actual runner; demonstrates the other half of the completing dead end |
| Provider NoSuchUpload | Both ListParts and Abort mapped to generic 503 | Actual storage service, SDK send stub; no R2 calls |
| Valid 2,000-part status | 130,990-byte response rejected by 64 KiB bound | Actual client parsing, synthetic Response; current CRM profile is smaller |
| Same connection, two handlers, limit two | `a,a,b,b` all 200; next `a` 429 | Actual guards and Nest/Fastify HTTP injection; confirms per-handler buckets |

Focused existing suites rerun after the source recheck:

- Extension runner, `CriticalWorkCoordinator`, `OffscreenManager` and webhook
  transport: **48 tests passed**, four suites, 3.18 seconds.
- CRM media guards, reconciliation and schema: **10 tests passed, one failed**,
  three suites, 1.61 seconds. The failure is again the Phase 1-only SQL comparison
  against `media_token_hash`; raw bounded output is in `/tmp/crm-media-plan-recheck.log`.

The controller spec existed with one-argument construction before Phase 2, and
Phase 2 changed the constructor to require its media service. Source comparison
with CRM `f1bc9a8a` confirms the origin of those two diagnostics; the remaining
repository-wide spec errors were not baseline-classified in this review.

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
