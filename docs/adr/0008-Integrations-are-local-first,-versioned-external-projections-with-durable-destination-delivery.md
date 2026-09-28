# ADR-0008 — Local-first external integrations and recording-data routing

**Status:** Proposed
**Date:** 2026-09-24
**Target:** post-PR #21 integration architecture
**Primary use cases:** self-written systems, internal CRM/ATS/MCS tools, private analysis systems, n8n/Zapier/Make, and later named SaaS connectors

## 1. Decision

External integrations will be implemented as a **separate local-first recording-data routing domain**.

The first integration transport is a user-configured outbound HTTP webhook:

```text
Recording Library
       │
       ▼
Integration Projector
       │
       ▼
Readiness + Routing
       │
       ▼
Durable Integration Delivery
       │
       ▼
Signed HTTP Webhook
       │
       ├── Custom/private system
       ├── Internal CRM / ATS
       ├── localhost / LAN system
       ├── n8n
       ├── Zapier
       └── Make
```

The project does **not** require an integration backend for V1.

Webhook payloads use:

* **CloudEvents structured JSON mode** for the event envelope;
* **Standard Webhooks 1.0** for webhook IDs, timestamps and signatures;
* a project-owned versioned recording schema inside the CloudEvent `data`.

CloudEvents structured JSON puts the event metadata and data into one body using `Content-Type: application/cloudevents+json`.

Standard Webhooks defines `webhook-id`, `webhook-timestamp` and `webhook-signature`, and signs the exact message ID, attempt timestamp and raw body.

The integration subsystem is **not part of the sharing subsystem**.

---

# 2. Architectural boundaries

The repository has three different concepts that must remain separate:

```text
                        RECORDING LIBRARY
                              │
                ┌─────────────┴─────────────┐
                │                           │
                ▼                           ▼
          INTEGRATIONS                   SHARING
                │                           │
      machine-readable data        human-playable publication
                │                           │
      webhook / SaaS APIs          Share Worker + viewer
                │                           │
                ▼                           ▼
         CRM / ATS / n8n             public capability URL
```

The dependency rule is:

```text
Integrations → Recording Library

Sharing      → Recording Library

Integrations ✕ Sharing
Sharing      ✕ Integrations
```

Neither domain depends on the other.

A future workflow that deliberately uses both must sit **above** them:

```text
Application workflow
       │
       ├── Sharing.publish(...)
       └── Integrations.send(...)
```

and must never be implemented as:

```text
Integrations → Sharing.publish(...)
```

hidden inside the integration domain.

---

# 3. Existing sharing module considered by this ADR

This ADR explicitly considers the sharing architecture currently implemented in PR #21.

Sharing is now a **Drive-backed revocable publication system**:

```text
private recording
       │
       ▼
Sharing module
       │
       ├── existing Drive file
       │
       └── OPFS → user's Drive when necessary
                     │
                     ▼
          immutable pinned Drive revision
                     │
       explicit reader permission
                     │
                     ▼
              Cloudflare Worker
              ├── D1 lifecycle/control
              ├── private origin metadata
              └── bounded temporary R2 cache
                     │
                     ▼
                public viewer
```

Its durable media origin is:

```text
Drive file ID + pinned revision ID
```

For new shares, R2 is **not** the durable media store.

R2 is a bounded fixed-TTL read-through cache.

The current sharing contract deliberately keeps these values private:

```text
Drive file ID
Drive revision ID
Drive permission ID
OPFS key
Google credentials
internal source recording ID
```

Published shares instead receive fresh public recording/track IDs.

Integrations follow the same privacy principle.

---

# 4. The sharing API is not the integration API

PR #21 already has an HTTP service contract for publication.

Representative owner/control routes include:

```text
POST   /api/auth/session

GET    /api/sharing-reader

GET    /api/shares
PUT    /api/shares/:shareId
GET    /api/shares/:shareId
DELETE /api/shares/:shareId

GET    /api/shares/:shareId/origins

PUT    /api/shares/:shareId
          /recordings/:recordingId
          /tracks/:trackId
          /origin

POST   /api/shares/:shareId/finalize
POST   /api/shares/:shareId/revoke

POST   /api/shares/:shareId/origin-cleanup/claim
POST   /api/origin-cleanup/claim-pending
POST   /api/origin-cleanup/:candidateId/complete
```

The sharing Worker also owns viewer/capability/media routes.

Those APIs exist exclusively to manage:

```text
publication
Drive-origin registration
capability creation
viewer authorization
protected Range playback
revocation
Drive cleanup coordination
published-data deletion
```

The integrations module MUST NOT reuse:

```text
ShareServiceClient
sharing-worker
share capability authentication
ShareOriginCleanupQueue
SharePublicationCoordinator
PublishedPlaybackManifest
```

as its generic integration transport.

The sharing Worker is **not an integration relay**.

If an integration cloud service is eventually required, it receives its own service/security boundary, conceptually:

```text
sharing-worker/
integration-worker/
```

---

# 5. Existing recording constraints

`RecordingHistoryEntry` currently contains:

```text
id
name
note
durationMs
createdAt
storage/delivery state
logical files + replicas
```

but does not persist canonical:

```text
recording startedAt
recording endedAt
provider
meeting ID
meeting URL
```

`createdAt` cannot be reinterpreted as `startedAt`, because its current meaning differs between storage/finalization paths.

Provider awareness already exists in the recording stack:

```ts
type MeetingProviderInfo = {
  providerId: 'google-meet' | 'unknown';
  meetingId: string | null;
  supportsCaptions: boolean;
};
```

The problem is therefore not the absence of a provider abstraction.

The problem is that the provider/run context is not persisted alongside the durable recording.

The future recorder can also record arbitrary tabs, so integrations cannot require that every recording represents a meeting.

---

# 6. Add a durable RecordingContext aggregate

Before freezing the integration payload schema, add a separate recording context aggregate to the existing `recording-history` database.

Do not reinterpret `createdAt`.

Do not require the history row to exist before context can be persisted.

Recommended shape:

```ts
type RecordingContext = {
  recordingId: string;

  startedAt: number;
  endedAt?: number;

  source: {
    kind: 'meeting' | 'tab';

    provider?: string;
    meetingId?: string;
    meetingUrl?: string;
  };
};
```

`provider` is an open bounded string externally.

Do not freeze:

```ts
provider: 'google-meet'
```

into the external integration contract.

### Lifecycle

At recording start:

```text
historyId known
       ↓
persist startedAt
       ↓
persist best-effort provider/source context
```

At recording finish:

```text
persist endedAt
```

Discard removes its context.

Recording deletion cleans it through the recording library's existing dependent-cleanup model.

### Clock semantics

Keep these concepts distinct:

```text
startedAt / endedAt
    wall-clock occurrence

durationMs
    pause-aware produced-media duration
```

They are not interchangeable.

---

# 7. Integrations have their own database

Create:

```text
meeting-integrations
```

rather than continually increasing the responsibilities of `recording-history`.

Recommended stores:

```text
destinations
secrets
routingIntents
streams
deliveries
```

Responsibilities:

```text
recording-history
    canonical recording/library state

meeting-integrations
    external routing and delivery state
```

The integration database must not duplicate full transcripts, media or complete webhook payloads.

---

# 8. Destination model

V1 destination:

```ts
type IntegrationDestination = {
  id: string;

  /** Unique external producer identity for this destination. */
  producerId: string;

  name: string;
  type: 'webhook';

  enabled: boolean;

  endpoint: string;

  routingDefault:
    | 'manual'
    | 'auto'
    | 'review';

  dataPolicy: IntegrationDataPolicy;

  requestAuth:
    | { type: 'none' }
    | { type: 'bearer'; secretId: string }
    | {
        type: 'api-key';
        header: string;
        secretId: string;
      };

  signingSecretId: string;

  /**
   * Increased when endpoint or request-auth identity changes.
   */
  connectionVersion: number;

  createdAt: number;
  updatedAt: number;
};
```

Generic OAuth is deferred.

OAuth belongs primarily to future named SaaS adapters or an optional credential broker/cloud relay.

---

# 9. Standard Webhooks authentication

V1 webhook signing uses the symmetric Standard Webhooks scheme:

```text
HMAC-SHA256
```

Create one high-entropy secret per destination.

Serialize it using:

```text
whsec_<base64 key>
```

Standard Webhooks specifies symmetric signing keys between 24 and 64 random bytes and the `whsec_` representation.

Use 32 cryptographically random bytes initially.

Headers:

```text
webhook-id
webhook-timestamp
webhook-signature
```

Signature input:

```text
webhook-id + "." +
webhook-timestamp + "." +
exact raw HTTP body
```

The exact bytes signed must be the exact bytes transmitted. Standard Webhooks explicitly warns that parsing/reserializing JSON can invalidate signatures.

### Secret handling

The plaintext signing secret:

* is shown when a destination is created or rotated;
* can be copied deliberately by the user;
* is not returned from normal destination-list/read APIs;
* is not logged;
* is not exported in diagnostics;
* is not included in telemetry.

If lost, rotate it rather than casually exposing stored secrets throughout the application.

V1 does not claim that extension-local storage is a hardware-backed secret vault.

---

# 10. CloudEvents envelope

Use structured CloudEvents:

```http
Content-Type: application/cloudevents+json
```

Example:

```json
{
  "specversion": "1.0",

  "id": "evt_01...",
  "source": "urn:meeting-recorder:destination:d_01...",

  "type": "com.example.recorder.recording.ready.v1",
  "subject": "recording/rec_01...",

  "time": "2026-09-24T15:15:00.000Z",

  "datacontenttype": "application/json",

  "data": {
    "revision": 1,

    "readiness": {
      "complete": true,
      "release": "complete",
      "pending": []
    },

    "recording": {
      "id": "rec_01..."
    }
  }
}
```

CloudEvents requires `id`, `source`, `specversion` and `type`; `source` identifies the context in which the event occurred.

The final `type` prefix must use a domain controlled by the project.

Do not freeze `com.example`.

---

# 11. Standard Webhooks ID and CloudEvents ID are the same

Do not create two event identifiers.

Use:

```text
CloudEvents id
        ==
Standard Webhooks webhook-id
```

For retry attempts:

```text
CloudEvents id       unchanged
CloudEvents time     unchanged
CloudEvent body      unchanged

webhook-id           unchanged
webhook-timestamp    new attempt timestamp
webhook-signature    recomputed
```

Standard Webhooks explicitly distinguishes the event occurrence time from the attempt timestamp and keeps the webhook identifier stable across retries.

---

# 12. Destination-scoped external identities

Do not export the internal:

```text
RecordingHistoryEntry.id
RecordingHistoryFile.id
Drive file ID
Drive revision ID
Drive permission ID
Download ID
OPFS key
notation storage ID
analysis storage ID
sharing public IDs
```

Each `(destination, recording)` stream receives its own external identifier:

```ts
type IntegrationStream = {
  destinationId: string;

  /** Internal only. */
  recordingId: string;

  /** Exposed to this destination only. */
  externalRecordingId: string;

  nextRevision: number;

  readyCreated: boolean;
  everAttempted: boolean;

  lastPlannedProjectionHash?: string;
};
```

Therefore:

```text
same local recording

CRM      → rec_A
Analyzer → rec_B
ATS      → rec_C
```

Unrelated integrations cannot correlate the extension's internal recording identity.

Similarly, CloudEvents `source` uses a random producer identity unique to the destination rather than a global extension-installation ID.

---

# 13. Integration payload is not PublishedPlaybackManifest

Sharing's `PublishedPlaybackManifest` answers:

> How can a human viewer play this immutable published snapshot?

The integration schema answers:

> What recording state should another software system store/process?

They require separate contracts.

Recommended V1 recording projection:

```ts
type IntegrationRecordingV1 = {
  id: string;

  title: string;

  startedAt: string;
  endedAt?: string;

  durationMs?: number;

  source: {
    kind: 'meeting' | 'tab';

    provider?: string;
    meetingId?: string;
    meetingUrl?: string;
  };

  note?: string;

  notations?: Array<{
    tStartMs: number;
    tEndMs?: number;
    text: string;
  }>;

  transcript?: {
    source: 'meet-captions' | 'stt';

    segments: Array<{
      tStartMs: number;
      tEndMs: number;
      speaker?: string;
      text: string;
    }>;
  };

  analysis?: {
    status:
      | 'analyzing'
      | 'completed'
      | 'failed'
      | 'canceled'
      | 'unsupported';

    error?: string;

    topics?: Array<{
      keywords: string[];
      importance: number;

      spans: Array<{
        tStartMs: number;
        tEndMs: number;
      }>;
    }>;
  };

  artifacts?: Array<{
    type:
      | 'tab-recording'
      | 'microphone-recording'
      | 'self-video'
      | 'notes'
      | 'transcript';

    mimeType: string;
    bytes?: number;

    delivery:
      | 'pending'
      | 'downloaded'
      | 'uploaded'
      | 'local-fallback'
      | 'failed';

    viewUrl?: string;
  }>;
};
```

Do not invent an artificial transcript processing status inside the stored transcript itself.

The current transcript aggregate is simply:

```ts
{
  source,
  segments
}
```

Pending readiness belongs to the integration readiness layer rather than pretending it is part of `Transcript`.

Analysis, however, already has an actual durable lifecycle:

```text
analyzing
completed
failed
canceled
unsupported
```

Use those real states rather than collapsing them into `none | processing | ready`.

---

# 14. Data policy

Every destination explicitly specifies what can leave the browser:

```ts
type IntegrationDataPolicy = {
  metadata: boolean;

  meetingIdentity: boolean;

  userNote: boolean;

  notations: boolean;

  transcript: boolean;

  analysis: boolean;

  artifactMetadata: boolean;

  artifactLinks: boolean;

  transcriptSpeakers:
    | 'names'
    | 'pseudonyms'
    | 'omit';
};
```

Defaults should be conservative.

Enabling transcript does not automatically enable:

```text
meeting URL
topic analysis
artifact links
media transfer
```

---

# 15. Speaker privacy

Transcript speaker names can expose information about people who did not configure the integration.

Support:

```text
Send original names
Replace with Speaker 1 / Speaker 2...
Remove speaker labels
```

Do not call this feature:

```text
Anonymize recording
```

because the title, notes, transcript body and meeting metadata can still identify people.

The UI should say:

> Replace transcript speaker names

Pseudonym assignment must remain stable for the same recording across revisions.

The implementation must not persist plaintext speaker names in the integration database solely to maintain pseudonyms.

---

# 16. Routing is per recording

Destination configuration is not enough.

A user may record:

```text
company call
private meeting
therapy session
recruiting interview
personal recording
```

in the same browser.

Therefore automatic integration routing must become visible per-recording state.

At recording start, materialize routing intent from destination defaults.

```ts
type RecordingIntegrationIntent = {
  recordingId: string;

  destinations: Array<{
    destinationId: string;

    mode:
      | 'auto'
      | 'review';

    state:
      | 'selected'
      | 'skipped'
      | 'needs-review'
      | 'approved';

    allowedPolicy: IntegrationDataPolicy;

    connectionVersion: number;

    approvedPolicyHash?: string;
  }>;
};
```

Manual destinations are absent until explicitly chosen.

---

# 17. Exactly three routing modes in V1

## MANUAL

Default.

Nothing is exported automatically.

User invokes:

```text
Send to…
```

A manual send is a **one-shot delivery decision**.

Later local changes do not automatically create further webhooks unless the user explicitly sends again.

## AUTO

The destination is selected automatically for new recordings.

The recording UI shows it immediately:

```text
Will send to:

[ Work CRM × ]
```

The user can remove it for this recording without changing global settings.

After the initial event, externally visible changes may automatically generate later revisions for that recording.

## REVIEW

The recording is selected but nothing leaves the browser until the user reviews/approves it.

Each newly prepared external revision requiring export remains reviewable rather than silently expanding what is sent.

---

# 18. Do not build routing rules yet

V1 does not include:

```text
meeting title contains X
participant domain is Y
URL matches pattern
specific weekday
specific account
regex routing
scripted routing
```

That would create a rule engine.

The three explicit modes solve the primary safety problem without that complexity.

---

# 19. Policy changes are privacy-monotonic

A later global destination-policy expansion must never expose more information from an already-selected recording automatically.

Effective policy:

```text
recordingIntent.allowedPolicy
       ∩
destination.currentDataPolicy
```

Consequences:

```text
destination policy narrows
    → applies immediately

destination policy expands
    → existing recordings do not gain new data automatically
```

The user must explicitly expand the old recording intent.

For REVIEW, such expansion invalidates existing approval.

---

# 20. Connection changes are not silent

Changing:

```text
destination URL
Bearer credential
API key
receiver identity
```

increments:

```text
connectionVersion
```

A pending delivery prepared for connection version 4 must not silently be sent to version 5.

Instead it becomes:

```text
action-required
```

until the user explicitly approves retrying against the changed connection.

Cosmetic changes such as destination name do not invalidate delivery.

---

# 21. Readiness is destination-specific

Do not emit an automatic event merely because recording capture stopped.

A destination requesting:

```text
metadata only
```

can become ready almost immediately.

A destination requesting:

```text
transcript + analysis + artifact link
```

may need to wait for later asynchronous work.

Readiness evaluates only requested data.

Conceptually:

```ts
evaluateReadiness(
  recording,
  effectivePolicy,
)
```

### Analysis

While:

```text
analyzing
```

analysis is pending.

These outcomes are terminal:

```text
completed
failed
canceled
unsupported
```

Failure or unsupported hardware cannot block a CRM forever.

### Artifact delivery

```text
pending
```

is non-terminal when a requested artifact link depends on it.

These are terminal:

```text
downloaded
uploaded
local-fallback
failed
```

---

# 22. Readiness has a durable deadline

AUTO/REVIEW flows cannot wait indefinitely.

Persist:

```text
readyDeadlineAt
```

per selected recording/destination stream.

The exact initial timeout is an implementation constant chosen from observed analysis/upload timings; it is not frozen into the protocol.

If the deadline expires:

```json
{
  "readiness": {
    "complete": false,
    "release": "timeout",
    "pending": ["analysis"]
  }
}
```

is valid.

Later, when analysis completes, a higher-revision:

```text
recording.updated.v1
```

contains the complete state.

If Chrome was closed while the deadline expired, startup reconciliation notices that the persisted deadline has passed.

---

# 23. Manual partial delivery is explicit

A user may choose to send before all selected data becomes ready.

In that case:

```json
{
  "readiness": {
    "complete": false,
    "release": "manual",
    "pending": ["analysis"]
  }
}
```

The event does not falsely claim completeness.

The three readiness release reasons are:

```text
complete
timeout
manual
```

---

# 24. Event vocabulary

Keep V1 small:

```text
<owned-domain>.recording.ready.v1
<owned-domain>.recording.updated.v1
<owned-domain>.recording.deleted.v1
<owned-domain>.integration.test.v1
```

## recording.ready.v1

First externally dispatchable snapshot for a destination/recording.

It may be:

```text
fully complete
released by timeout
manually released
```

## recording.updated.v1

A complete replacement snapshot for a higher revision.

Receivers must be able to process it even if `recording.ready` was lost or arrives later.

## recording.deleted.v1

Minimal deletion tombstone.

## integration.test.v1

Synthetic connection test.

Never contains real recording data.

---

# 25. Full-state revisions

Each:

```text
destination + recording
```

stream receives monotonically increasing revisions:

```text
1
2
3
...
```

Every ready/updated event contains the **full externally allowed current state**, not a field-level patch.

The receiver contract is:

```ts
if (incoming.revision <= storedRevision) {
  return 200;
}

replaceExternalRecording(incoming.recording);
storedRevision = incoming.revision;
```

Importantly, replacement semantics include removal.

If revision 4 contains transcript data and revision 5 legitimately omits transcript because the policy was narrowed, the receiver should treat revision 5 as the current complete allowed representation rather than retaining fields from revision 4 forever.

---

# 26. Ordering only within one recording

Never serialize the entire destination.

Bad:

```text
CRM

Recording A retrying for six hours
       ↓
Recording B blocked
       ↓
Recording C blocked
```

Required concurrency model:

```text
CRM

Recording A r3 → retrying
Recording B r1 → delivered
Recording C r2 → delivered
```

Ordering key:

```text
destinationId + recordingId
```

Different streams may progress concurrently.

---

# 27. Projection changes create revisions

Internal state changes do not automatically mean webhook events.

The integration coordinator rebuilds the **destination-filtered external projection**.

If its external projection hash has not changed:

```text
no revision
no webhook
```

This prevents internal bookkeeping from causing integration traffic.

Useful reconciliation hints come from durable transitions such as:

```text
recording finalized
history renamed
recording note changed
notation changed
transcript changed/settled
analysis terminal state changed
artifact delivery changed
recording deleted
```

Those callbacks only call something conceptually like:

```ts
integrations.consider(recordingId);
```

They do not pass prepared webhook bodies.

The integration subsystem re-reads durable library state.

---

# 28. Do not introduce a generic application event bus

Existing domain transitions may notify the IntegrationCoordinator through narrow injected callbacks/ports composed in `createBackgroundRuntime()`.

Do not create a global publish/subscribe infrastructure solely for integrations.

Startup reconciliation remains the safety net if one hint was lost.

---

# 29. Durable outbox stores references, not transcripts

Do not persist another copy of:

```text
transcript
notations
analysis projection
complete CloudEvent body
```

inside integration delivery state.

Recommended delivery row:

```ts
type IntegrationDelivery = {
  id: string;

  destinationId: string;
  recordingId: string;

  externalRecordingId: string;

  eventId: string;

  eventType:
    | 'recording.ready.v1'
    | 'recording.updated.v1'
    | 'recording.deleted.v1'
    | 'integration.test.v1';

  revision: number;

  eventTime: number;
  connectionVersion: number;

  state:
    | 'pending'
    | 'delivering'
    | 'retrying'
    | 'delivered'
    | 'failed'
    | 'superseded'
    | 'canceled'
    | 'action-required';

  attemptCount: number;

  nextAttemptAt?: number;

  /** SHA-256 of the exact serialized CloudEvent body. */
  bodyHash?: string;

  lastStatus?: number;
  lastErrorCode?: string;

  createdAt: number;
  updatedAt: number;
};
```

Deletion of the original recording therefore does not leave a second transcript hiding in the integration outbox.

---

# 30. Same event ID must always mean same body

This is a hard protocol invariant.

First attempt:

```text
read durable state
       ↓
project using effective policy
       ↓
construct CloudEvent using stored eventId/eventTime
       ↓
deterministically serialize
       ↓
SHA-256 exact body
       ↓
persist bodyHash
       ↓
sign exact body
       ↓
POST
```

Retry:

```text
rebuild exact event
       ↓
serialize
       ↓
hash

same as bodyHash?
   │
   ├── yes → same event ID, retry
   │
   └── no  → do NOT reuse event ID
```

If the body changed:

```text
old delivery → superseded

new revision
new event ID
new event time
new body hash
```

This avoids the failure where a receiver deduplicates an ID even though the sender silently changed its meaning.

Standard Webhooks explicitly defines the webhook ID as stable across retries and commonly used as an idempotency key.

---

# 31. New full-state revisions supersede stale retries

Suppose:

```text
revision 3 → 503, waiting to retry
```

and local state changes enough to create:

```text
revision 4
```

Because revision 4 is a complete replacement state, revision 3 does not need to remain ahead of it forever.

If safe according to the current delivery state:

```text
revision 3 → superseded
revision 4 → pending
```

The receiver's monotonic revision rule handles delayed older events if any were already in flight.

---

# 32. Delivery semantics

Delivery is:

```text
at least once
```

not exactly once.

HTTP success:

```text
any 2xx
```

Retryable:

```text
network error
timeout
408
425
429
5xx
```

Respect `Retry-After` for `429`/applicable service errors, with a bounded cap.

Non-retryable/actionable examples:

```text
3xx → do not follow redirect
400 → invalid request/configuration
401 → credentials problem
403 → authorization problem
410 → destination gone
413 → payload too large
```

Standard Webhooks likewise recommends successful `2xx` handling, retries with backoff/jitter, `Retry-After`, visibility and manual replay.

Use bounded exponential backoff with full jitter.

Exact retry constants remain centralized implementation constants rather than protocol guarantees.

---

# 33. Scheduler uses durable state

Use one integration-delivery alarm representing the earliest durable `nextAttemptAt`, not one permanent Chrome alarm per delivery.

Process:

```text
find earliest due delivery
       ↓
create/update one wake-up alarm
       ↓
alarm fires
       ↓
claim bounded due work
       ↓
deliver
       ↓
persist state
       ↓
schedule next earliest time
```

The outbox is the truth.

The alarm is only a wake-up mechanism.

Chrome documents that alarms may have different persistence behavior by browser/version and recommends ensuring important alarms exist whenever the service worker starts. Current Chrome also supports an explicit `persistAcrossSessions` option in newer versions, but startup reconstruction remains necessary for compatibility.

Therefore every startup/reconciliation path verifies or rebuilds the integration alarm.

---

# 34. Do not keep the service worker alive for webhook jobs

Small JSON webhook HTTP requests run from background.

They do not require the offscreen data plane.

Use a bounded request timeout below Chrome's service-worker fetch-response limit.

Chrome documents that an extension service worker may be terminated if a `fetch()` response takes more than 30 seconds and recommends designing service workers to survive unexpected termination.

Recommended transport timeout:

```text
15–25 seconds
```

not an unbounded request.

Persistent state makes termination safe.

---

# 35. Integration work must not block extension updates

Do not register ordinary webhook deliveries as indispensable long-running capture work.

If the browser/service worker disappears:

```text
durable delivery remains
       ↓
next startup reconciles it
```

This is different from PR #21's offscreen media/publication pipeline, where a resumable data-plane operation may legitimately continue for much longer.

---

# 36. Runtime host permissions

The current manifest does not contain broad integration host permissions.

Add optional host capability rather than permanent installation-time access.

Chrome supports:

```json
{
  "optional_host_permissions": [
    "https://*/*"
  ]
}
```

and allows requesting only the specific runtime origin needed by the user. Optional permissions must be requested from a user gesture.

If Phase 0 validates HTTP localhost/LAN support, also add the required HTTP optional pattern.

When configuring:

```text
https://crm.example.com/hooks/recordings
```

request only the necessary origin pattern rather than automatically granting every HTTPS site.

Permission prompting happens from the full Settings page on explicit:

```text
Test connection
Save
```

actions.

Automatic delivery must never spontaneously open a permission request.

If permission disappears later:

```text
delivery → action-required
```

---

# 37. Endpoint validation and fetch hardening

Allowed schemes:

```text
https:
http: only where Phase 0 explicitly supports it
```

Reject:

```text
file:
data:
javascript:
chrome:
chrome-extension:
```

Reject URL-embedded credentials:

```text
https://username:password@server/
```

Conceptual request policy:

```ts
fetch(endpoint, {
  method: 'POST',

  credentials: 'omit',
  redirect: 'manual',
  cache: 'no-store',
  referrerPolicy: 'no-referrer',

  headers,
  body,
  signal,
});
```

Do not follow redirects while carrying:

```text
transcripts
API credentials
Bearer credentials
webhook signatures
```

A redirecting destination must be updated to its final endpoint explicitly.

---

# 38. Phase 0 must verify LAN/localhost behavior

Do not claim LAN integration support from assumptions.

Chrome's Local Network Access model covers local and loopback destinations and has browser permission implications; service-worker-originated local requests have additional behavior that must be verified in the extension context.

Before freezing LAN support, create a throwaway integration spike.

Test from:

```text
extension Settings page
extension service worker
```

against:

```text
public HTTPS

http://localhost:<port>
http://127.0.0.1:<port>

http://192.168.x.x:<port>
http://server.local:<port>
http://private-dns-name:<port>

HTTPS LAN + trusted certificate
HTTPS LAN + self-signed certificate
```

For every relevant case:

```text
before host permission
after exact host permission
after browser restart
after service-worker restart
```

Record:

```text
works?
host permission needed?
Local Network Access interaction?
CORS/preflight behavior?
HTTP permitted?
certificate behavior?
```

Run on supported desktop operating systems where practical.

Commit the result as a compatibility table beside this ADR.

Until that spike passes, the product can safely promise:

```text
arbitrary HTTPS webhook
```

but must treat localhost/LAN support as provisional.

---

# 39. Never bypass TLS validation

If:

```text
https://internal-server/
```

uses an untrusted/self-signed certificate and Chrome rejects it, integrations fail visibly.

Do not add:

```text
Ignore certificate errors
```

behavior.

The endpoint must use a certificate trusted by Chrome/the operating system or another supported endpoint configuration.

---

# 40. Payload size is explicit

Local-first V1 deliberately differs from the usual "tiny webhook + pull API" architecture.

The extension is not a publicly callable HTTP server, so the receiver cannot reliably call back for:

```text
GET transcript
GET recording
```

after receiving a thin notification.

Events therefore may contain substantial recording state.

Standard Webhooks recommends keeping normal webhook payloads small; our full-transcript use case is a conscious exception because there is no V1 pull API.

Every payload is measured before network transmission.

Process:

```text
project
serialize exact CloudEvent
measure UTF-8 bytes
check configured product/destination limit
```

Oversized event:

```text
does not blindly retry
```

UI example:

```text
Payload too large

Total        2.7 MB
Transcript   2.5 MB
Other        0.2 MB

[ Change data selection ]
```

HTTP `413` receives the same explicit classification.

The exact initial byte cap is chosen through testing and is not permanently frozen by the ADR.

---

# 41. Preview Payload is part of the architecture

Implement before automatic delivery:

```text
Preview payload
Download JSON
```

Preview shows exactly what this destination would receive.

It must use the same:

```text
IntegrationProjector
CloudEvent builder
serializer
```

as production webhooks.

Invariant:

```text
Preview body
==
Downloaded JSON
==
Webhook CloudEvent body
```

apart from a deliberately synthetic test event where applicable.

Preview should display:

```text
event type
schema version
revision
readiness
payload byte size
selected data
speaker-name behavior
```

This both improves user trust and gives custom-system developers real fixtures.

---

# 42. n8n, Zapier and Make are webhook presets

Do not implement:

```text
N8nTransport
ZapierTransport
MakeTransport
```

They already consume generic webhook requests.

Product UX may offer:

```text
Add integration

Generic webhook
n8n
Zapier
Make
```

but these all create:

```ts
type: 'webhook'
```

The preset changes:

```text
instructions
URL hints
sample workflow
importable template
```

not runtime transport architecture.

---

# 43. Test Connection uses the actual transport

Do not test only with:

```text
HEAD
OPTIONS
```

because many webhook receivers implement POST only.

`TEST_INTEGRATION` sends:

```text
<domain>.integration.test.v1
```

containing synthetic data.

It passes through the production:

```text
serializer
Standard Webhooks signer
request-auth logic
fetch transport
timeout behavior
```

No real recording/transcript is required.

---

# 44. UX — destination settings

Settings → Integrations:

```text
INTEGRATIONS

Internal CRM
Webhook
https://crm.company.internal/hooks/recordings
AUTO
Active

Private analyzer
Webhook
https://localhost:8799/events
MANUAL
Active

+ ADD INTEGRATION
```

Editor:

```text
Name
[ Internal CRM ]

Endpoint
[ https://... ]

Routing
● Manual
○ Automatic
○ Review before sending

Data
☑ Metadata
☐ Meeting identity / URL
☑ User note
☑ Notations
☑ Transcript
☐ Topic analysis
☐ Artifact metadata
☐ Existing artifact links

Speaker names
● Original names
○ Speaker 1 / Speaker 2
○ Remove labels

Request authentication
[ None / Bearer / API key ]

Webhook verification
Standard Webhooks
HMAC-SHA256

[ Preview test event ]
[ Test connection ]
[ Save ]
```

The editor must say:

> Automatic delivery requires the browser to be running. Pending deliveries resume when the browser starts again.

---

# 45. UX — per-recording routing

During recording:

```text
Will send to

[ Work CRM × ]
[ Archive · Review ]
```

After capture:

```text
INTEGRATIONS

Work CRM
Waiting for analysis…

Archive
Ready for review
[ Review & send ]

Private analyzer
Not selected
[ Send ]
```

Delivery:

```text
Work CRM
✓ Sent · 14:15

Archive
↻ Retry scheduled

Private analyzer
! Payload too large
[ Change data ] [ Retry ]
```

Integration failure must never mark the recording itself as failed.

---

# 46. Deletion semantics

Deleting the local recording cancels unsent integration deliveries.

If a destination has never received or potentially received anything:

```text
cancel
no external tombstone necessary
```

If an event:

```text
was confirmed delivered
or
was attempted and outcome is ambiguous
```

create the highest revision:

```text
recording.deleted.v1
```

Minimal payload:

```json
{
  "revision": 6,
  "recording": {
    "id": "rec_external...",
    "deletedAt": "..."
  }
}
```

Do not retain the deleted transcript merely to construct the tombstone.

The product must explain:

> Deleting the recording here cannot guarantee deletion from systems it was previously exported to.

The tombstone is a protocol request for downstream deletion, not a guarantee.

---

# 47. Sharing must never be an implicit side effect

This is especially important after PR #21.

Publishing a share now performs security-sensitive operations including:

```text
ensure media exists in the user's Drive
pin an exact Drive revision
grant the sharing-reader service account file access
register private origin metadata
create a capability
enable protected public playback
```

Therefore:

```text
Send to CRM
```

must never secretly mean:

```text
Publish public share
then send URL
```

That violates the sharing trust boundary.

V1 integrations can send:

```text
metadata
notes
transcript
analysis
artifact metadata
explicitly permitted pre-existing links
```

but do not create a share.

A future option such as:

```text
☑ Create a revocable playback link for this integration
```

requires an explicit higher-level user workflow.

---

# 48. Existing sharing links may be handled only explicitly

If a recording already has an active share and a future feature allows exporting that link, this must be separately represented by data policy.

For example:

```ts
playbackLinkPolicy:
  | 'none'
  | 'existing-share'
  | 'create-share-with-confirmation';
```

Do not overload generic `artifactLinks` to silently manufacture public capabilities.

This is deferred from V1.

---

# 49. Binary media transfer is not a webhook feature

Do not embed:

```text
WebM
MP4
multi-GB media
base64 recordings
```

inside generic recording webhooks.

V1 handles structured data only.

If users later need:

```text
upload full recording to custom CRM
```

build a dedicated resumable media transport.

---

# 50. PR #21 already contains the future byte-source seam

PR #21 currently has:

```ts
type ShareMediaSource = {
  size: number;

  read(
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Blob>;
};
```

Do not duplicate it today as:

```text
IntegrationMediaSource
ArtifactByteSource
```

just because integrations may someday upload media.

While sharing is the only consumer:

```text
src/sharing/ShareMediaSource.ts
```

remains sharing-local.

When a second real media consumer exists:

```text
Sharing
+
IntegrationMediaUploader
```

extract/rename it into a neutral lower layer, for example:

```text
src/media/ArtifactByteSource.ts
```

Then both modules depend downward:

```text
Sharing ──────────┐
                  ├── ArtifactByteSource
Integrations ─────┘
```

Do not make:

```text
Integrations → ShareMediaSource
```

a permanent dependency.

---

# 51. Named SaaS APIs are later transports

Future named adapters may call vendor APIs such as:

```text
HubSpot
Salesforce
Greenhouse
Lever
other CRM / ATS systems
```

behind a transport interface:

```ts
interface IntegrationTransport {
  deliver(
    destination: IntegrationDestination,
    event: PreparedIntegrationEvent,
    signal?: AbortSignal,
  ): Promise<DeliveryResult>;
}
```

Possible implementations:

```text
WebhookTransport
HubSpotTransport
SalesforceTransport
GreenhouseTransport
LeverTransport
CloudRelayTransport
NativeBridgeTransport
```

Recording/library code contains no vendor-specific branches.

Build these only from real demand.

---

# 52. Optional integration cloud relay comes later

V1 does not need a project-owned backend.

Direct extension delivery is actually superior for:

```text
localhost
LAN
VPN
private corporate host
self-written system
```

A future cloud relay solves different requirements:

```text
deliver while browser is closed
managed confidential OAuth credentials
static outbound IP
server-to-server integrations
centrally managed retries
public pull API
```

Future architecture:

```text
                   ┌── Direct ──► local/private system
Extension ─────────┤
                   └── Relay ───► public SaaS
```

The relay must not be implemented inside `sharing-worker`.

---

# 53. Inbound API, native bridge and MCP are later ADRs

V1 direction is:

```text
extension → external system
```

not:

```text
external system → extension
```

Inbound CRM commands require a fundamentally different authentication/reachability model.

Systems without HTTP may later use:

```text
Extension
   ↓
Chrome Native Messaging
   ↓
native companion
   ↓
local/custom software
```

An MCP interface may eventually expose recording search/query functionality for AI systems.

Neither belongs to V1 outbound webhook delivery.

---

# 54. No generic transformation language

V1 does not implement:

```text
JSONPath mappings
Handlebars templates
arbitrary JavaScript
regex transforms
custom payload scripting
```

The stable external contract is intentionally predictable.

Custom systems can consume it directly.

n8n/Zapier/Make can transform it.

Only add mapping if real customers demonstrate a need that cannot reasonably be solved at the receiving side.

---

# 55. Background integration

Add an explicit background route owner:

```ts
type PopupRouteOwner =
  | 'drive-token'
  | 'share-identity-token'
  | 'library'
  | 'playback'
  | 'recording'
  | 'system'
  | 'integrations';
```

Integration messages are non-session operations.

Suggested commands:

```text
LIST_INTEGRATIONS
CREATE_INTEGRATION
UPDATE_INTEGRATION
DELETE_INTEGRATION

TEST_INTEGRATION
PREVIEW_INTEGRATION_PAYLOAD

LIST_RECORDING_INTEGRATION_INTENT
UPDATE_RECORDING_INTEGRATION_INTENT
APPROVE_RECORDING_INTEGRATION

SEND_RECORDING_TO_INTEGRATION

LIST_INTEGRATION_DELIVERIES
RETRY_INTEGRATION_DELIVERY
```

A webhook failure must never call:

```ts
recordingSession.fail()
```

---

# 56. Composition root

`createBackgroundRuntime()` composes the new subsystem.

Conceptually:

```ts
const integrations = createIntegrationRuntime({
  history: library.history,
  recordingContexts: library.recordingContexts,
  notations: library.notations,
  transcripts: library.transcripts,
  analyses: library.analyses,

  permissions,
  alarms,

  logger,
});
```

The integration domain receives interfaces rather than importing background/runtime internals.

Existing background architecture rules remain intact.

---

# 57. Suggested module structure

```text
src/
├── integrations/
│   ├── README.md
│   │
│   ├── IntegrationCoordinator.ts
│   ├── IntegrationProjector.ts
│   ├── IntegrationReadiness.ts
│   ├── IntegrationEventPlanner.ts
│   ├── IntegrationDispatcher.ts
│   ├── IntegrationScheduler.ts
│   │
│   ├── IntegrationDatabase.ts
│   ├── IntegrationDestinationRepository.ts
│   ├── IntegrationRoutingRepository.ts
│   ├── IntegrationStreamRepository.ts
│   ├── IntegrationDeliveryRepository.ts
│   ├── IntegrationSecretRepository.ts
│   │
│   ├── webhook/
│   │   ├── WebhookTransport.ts
│   │   ├── StandardWebhookSigner.ts
│   │   ├── WebhookEndpoint.ts
│   │   └── WebhookAuth.ts
│   │
│   └── __tests__/
│
├── background/
│   └── integrations/
│       └── BackgroundIntegrationRuntime.ts
│
├── shared/
│   ├── integrations.ts
│   └── integrationContract.ts
│
└── settings/
    └── integrations/
        ├── IntegrationList.ts
        └── IntegrationEditor.ts
```

Only after actual media-transfer demand:

```text
src/media/ArtifactByteSource.ts
src/offscreen/integrations/IntegrationArtifactUploader.ts
```

---

# 58. Startup reconciliation

Core recording startup must not fail because integration recovery failed.

After the primary background runtime is usable:

```text
integrations.reconcile()
scheduler.ensureAlarm()
```

Reconciliation checks:

```text
AUTO/REVIEW intents missing planned work
expired readiness deadlines
pending deliveries
retrying deliveries
stale "delivering" states
changed connection versions
missing host permissions
deleted recordings with queued work
missing scheduler alarm
```

Integration callbacks improve latency.

Reconciliation guarantees correctness.

---

# 59. Relationship to PR #21 recovery

PR #21 has its own durable recovery mechanisms for:

```text
publication replay
OPFS → Drive resumable copy
origin registration
revoke/delete
server-generated Drive cleanup candidates
owner-side permission/pin cleanup
```

The integration subsystem must not reuse those state machines.

Instead it follows the same **architectural principle**:

```text
persist durable intent/state
before relying on remote side effects
```

while keeping independent persistence and lifecycle.

This is pattern reuse, not module reuse.

---

# 60. Observability

Track bounded operational facts such as:

```text
delivery attempted
delivery succeeded
retryable failure
permanent failure
payload too large
permission missing
readiness timeout
delivery latency
retry count
```

Do not log/telemeter:

```text
endpoint URL
destination name
recording title
meeting URL
transcript
notation text
speaker names
CloudEvent body
API credentials
Bearer token
Standard Webhooks secret
Drive identifiers
```

---

# 61. Developer contract

Ship:

```text
docs/integrations/
├── integration-events.asyncapi.yaml
├── receiving-webhooks.md
├── schemas/
│   ├── recording-ready-v1.json
│   ├── recording-updated-v1.json
│   ├── recording-deleted-v1.json
│   └── integration-test-v1.json
├── examples/
│   ├── node/
│   └── python/
└── fixtures/
```

Use AsyncAPI for the event surface.

Use JSON Schema for payloads.

Reference receivers should use existing Standard Webhooks libraries rather than teaching users to hand-roll cryptography. Standard Webhooks currently publishes reference libraries for JavaScript/TypeScript, Python, Java/Kotlin, Rust, Go, Ruby, PHP, C#, Elixir and others.

No OpenAPI pull API is required for V1 because the extension does not host a reachable REST service.

---

# 62. Unit tests

Pin at least:

```text
RecordingContext migration/lifecycle

projection
data-policy filtering
private-locator rejection

destination-scoped IDs
producer IDs

speaker masking
stable pseudonyms

readiness evaluation
readiness timeout
manual partial readiness

manual/auto/review routing

policy-intersection privacy
connection-version invalidation

projection fingerprinting
revision monotonicity
revision supersession

CloudEvents validation
deterministic serialization

Standard Webhooks official test vectors
exact-body signing

same-ID/same-body invariant

endpoint validation
runtime origin derivation

retry classification
Retry-After parsing

payload byte limit

deletion tombstones

scheduler reconstruction
startup reconciliation
```

Hard regression test:

```text
same event ID
+
different body
```

must be impossible.

---

# 63. E2E tests

Run a real local HTTP receiver beside Chromium.

Test:

```text
Preview payload
Download JSON
Test connection

manual send
auto send
review send

speaker masking
data-policy filtering

503 retry
429 + Retry-After

successful receiver commit
response disappears
browser restarts
same event ID retries same body

payload changes before retry
old event superseded
new revision receives new ID

two recordings sent to same broken endpoint
second is not blocked

host permission denied
host permission revoked

endpoint changed with queued work

analysis timeout
late analysis → updated revision

payload too large
server 413

local recording deleted
pending work canceled
tombstone sent when necessary
```

Critical recovery scenario:

```text
receiver stores event
        ↓
response lost
        ↓
Chrome closes
        ↓
Chrome reopens
        ↓
same event ID
same CloudEvent body
new webhook-timestamp/signature
        ↓
receiver deduplicates
        ↓
extension marks delivery successful
```

---

# 64. Dedicated Phase 0 network E2E

Separately validate:

```text
public HTTPS
localhost
127.0.0.1
private IPv4
.local host
private DNS
trusted local HTTPS
untrusted/self-signed local HTTPS
```

from:

```text
extension page
service worker
```

Do not merge "LAN supported" until this matrix is understood.

---

# 65. CI

Create an integration-specific change-aware validation domain.

Relevant paths include:

```text
src/integrations/**
src/background/integrations/**
src/shared/integration*
src/settings/integrations/**
tests/e2e/integration-*
integration docs/schemas

RecordingContext code

manifest/platform permission code
when changed
```

Do not make every unrelated extension change pay for expensive integration E2E.

However, known dependencies of the integration projector/readiness system must be included in the fingerprint/dependency graph so relevant changes cannot accidentally skip tests.

Follow the change-aware approach already used by the current CI architecture.

---

# 66. Implementation sequence

## Phase 0 — prove environmental assumptions

Implement the local-network compatibility spike.

At the same time design/finalize `RecordingContext`.

**Exit:**

```text
LAN/localhost matrix known
RecordingContext contract reviewed
```

---

## Phase 1 — durable recording context

Add:

```text
startedAt
endedAt
source kind
provider
meeting ID
meeting URL where reliably available
```

as the separate recording-library aggregate.

Add migrations/recovery/delete/discard tests.

**Exit:** integrations no longer need to guess meeting occurrence data from `createdAt`.

---

## Phase 2 — external contract and projector

Implement:

```text
IntegrationRecordingV1
CloudEvents envelope
data policy
speaker masking
destination-scoped IDs
deterministic serializer
payload sizing
JSON Schemas
```

No networking required yet.

**Exit:** projector tests prove private storage locators cannot leak.

---

## Phase 3 — Preview / Download JSON

Implement:

```text
Preview payload
Download JSON
```

through the production serializer.

**Exit:** custom-system developers can already build receivers using real event fixtures.

---

## Phase 4 — integration persistence

Create:

```text
meeting-integrations
destinations
secrets
routingIntents
streams
deliveries
```

with migration and repository tests.

**Exit:** routing/delivery state survives a full restart.

---

## Phase 5 — thin manual webhook vertical slice

Implement:

```text
Add destination
exact host permission
Standard Webhooks secret
Test Connection
manual Send
delivery status
```

No automatic routing required yet.

**Exit:** self-written HTTPS receiver accepts and verifies a real recording event.

---

## Phase 6 — durable reliable delivery

Add:

```text
reference-only outbox
body fingerprints
same-body retry invariant
backoff/jitter
Retry-After
bounded concurrency
alarm reconstruction
lost-response recovery
revision supersession
delivery history
manual retry
```

**Exit:** restart/lost-response E2E passes.

---

## Phase 7 — readiness and versioning

Implement:

```text
destination-specific readiness
readiness deadline
recording.ready
recording.updated
full-state revision semantics
```

**Exit:** asynchronous transcript/analysis/artifact state can never produce an indefinite wait.

---

## Phase 8 — AUTO and REVIEW UX

Implement:

```text
manual/auto/review
per-recording chips
skip override
review approval
privacy-monotonic policies
```

**Exit:** no recording is silently exported merely because another recording uses the same browser profile.

---

## Phase 9 — deletion and complete history UX

Implement:

```text
recording.deleted
queued-work cancelation
ambiguous-attempt tombstones
per-recording delivery history
action-required states
```

---

## Phase 10 — developer ecosystem

Ship:

```text
AsyncAPI
JSON Schema
TypeScript receiver
Python receiver
n8n workflow
Zapier guide/template
Make guide/template
real fixtures
```

---

## Phase 11 — resumable media transfer

Only after real demand.

At this point extract PR #21's `ShareMediaSource` concept into a neutral artifact-byte-source layer.

Do not do this extraction earlier.

---

## Phase 12 — named SaaS adapters

Based on observed demand:

```text
CRM
ATS
other systems
```

---

## Phase 13 — optional integration cloud

Only when requirements justify:

```text
browser-off delivery
managed OAuth
confidential credentials
static IP
public APIs
```

Use a separate service from sharing.

---

## Phase 14 — native/inbound/MCP

Separate ADRs.

---

# 67. V1 non-goals

V1 explicitly does not implement:

```text
generic mapping DSL
arbitrary JavaScript transforms
advanced routing rules

binary media in webhook POST

implicit share publication

integration through sharing-worker

public pull API

delivery while browser is permanently closed

named CRM/ATS transports

bidirectional integration

native companion

MCP server
```

These are deferred, not architecturally forbidden.

---

# 68. Acceptance criteria

The foundation is ready when:

1. A developer can integrate a self-written HTTPS receiver without modifying extension code.
2. No integration destination must be known at build time.
3. No project-owned integration backend is required.
4. Sharing PR #21 remains independently deployable and independently testable.
5. The sharing Worker is not used as the generic integration relay.
6. Integrations never expose sharing-private Drive/OPFS locators.
7. Integrations never implicitly create public shares.
8. Each destination receives its own external recording IDs.
9. Manual routing is the default.
10. AUTO destinations are visible/removable for the individual recording.
11. REVIEW sends nothing until explicit approval.
12. Later destination-policy expansion cannot silently expose more data from old recording intents.
13. Webhook events are structured CloudEvents.
14. Webhook authentication follows Standard Webhooks.
15. `CloudEvents.id === webhook-id`.
16. One event ID can never refer to different serialized bodies.
17. Successful-but-lost responses produce safe duplicate retries.
18. Receivers can use monotonic revisions to reject stale/out-of-order updates.
19. One failed recording cannot block other recordings sent to the same endpoint.
20. Analysis failure/unsupported state cannot block readiness forever.
21. The integration database contains no copied full transcripts solely for delivery.
22. Payload limits are checked before repeated network attempts.
23. Integration failures never fail recording capture/history.
24. Browser restart reconstructs pending delivery scheduling.
25. Deleting a recording cancels unsent work and emits a tombstone where downstream data may already exist.
26. Generic webhooks never transport huge media files.
27. The UI clearly states the browser-running limitation.
28. LAN/localhost support is advertised only according to measured Phase 0 results.

---

# 69. Consequences

The project ends with three clean domains:

```text
Recording Library
    owns private recording truth

Sharing
    owns revocable human playback publication

Integrations
    owns explicit machine-to-machine routing
```

PR #21's sharing architecture remains optimized for:

```text
immutable media publication
Drive-backed playback
capability authorization
revocation
viewer streaming
```

The new integration architecture is optimized for:

```text
structured recording data
privacy-controlled export
custom/private systems
idempotent delivery
revisions
recovery
```

They reuse architectural principles:

```text
durable intent
persist-before-side-effect
external sanitized IDs
restart reconciliation
bounded sensitive state
```

without reusing each other's business state machines.

The core product abstraction is therefore not:

> "CRM integration"

and not:

> "webhook support"

It is:

> **A user-controlled, versioned routing layer that projects a private recording into an external representation and reliably delivers that representation to the system that owns the next step.**

That abstraction supports custom systems first, automation platforms immediately, named CRM/ATS integrations later, and an optional cloud relay without contaminating the recording or sharing domains.
