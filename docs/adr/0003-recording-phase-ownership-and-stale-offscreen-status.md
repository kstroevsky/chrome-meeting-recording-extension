# ADR-0003 — Recording phase ownership: fence stale offscreen status with a run epoch

- **Status:** Accepted
- **Date:** 2026-06-15

## Context

The recording `phase` (`idle | starting | recording | stopping | uploading | failed`)
appears to be owned by two places — the background `RecordingSession` (canonical,
persisted across service-worker restarts) and the offscreen `OffscreenController`,
which keeps its own `phase` and broadcasts `OFFSCREEN_STATE`. That framing is
imprecise. The code is actually a **command/status** split:

- **Background → offscreen carries only commands**: `OFFSCREEN_START` / `OFFSCREEN_STOP`
  (`RecordingController`). There is no "set phase" command.
- **Offscreen → background carries only status**: `OFFSCREEN_STATE { phase }`.
  The offscreen self-derives its phase from engine events and **never reads** the
  background's phase. `hydratePhase` only syncs the badge, it does not write into
  the offscreen document.

So the conflict is not symmetric dual-write. It is that the background **merges two
different concepts — its own command-intent (`session.start()` ⇒ `starting`) and
the offscreen's observed-status (`applyOffscreenPhase`) — into one stored `phase`
field.** A stale or out-of-order `OFFSCREEN_STATE` (a status message reflecting a
*previous run* that lands during a new one — e.g. a leftover `idle` after a port
reconnect, an SW restart, or a `recreateStaleOffscreen`) overwrites the merged
field. The known instance — a pre-start `idle` clobbering `starting` — was patched
by a hard-coded special case in the **wiring** (`background.ts`):

```ts
if (session.getSnapshot().phase === 'starting' && msg.phase === 'idle') return;
```

This guard is in the wrong layer (it lives outside the state machine that owns the
rule) and covers exactly one illegal transition; other stale-message races are
unguarded, and the canonical machine's documented transition diagram is not
actually enforced (`applyOffscreenPhase` applies updates unconditionally).

The channel itself (a `chrome.runtime.Port`) is per-connection FIFO, so the
staleness is **not** intra-port reordering — it is messages that survive a run
boundary (reconnect / document recreation / SW restart). That is precisely the
shape of a **stale-writer-from-a-previous-epoch** problem.

## Decision

**1. Fence offscreen status with a per-run epoch (a fencing token).**
The background assigns a monotonically increasing `epoch` on each `start()`,
persists it in the session snapshot, and sends it in `OFFSCREEN_START`. The
offscreen stores that epoch and echoes it in every `OFFSCREEN_STATE`. The
background drops any status whose epoch ≠ the current epoch. This generalizes the
`starting → idle` band-aid into a single rule that rejects *all* cross-run stale
status, and it survives SW restarts because the epoch is persisted (the live
offscreen keeps echoing the same epoch the rehydrated session expects). The epoch
is control-plane bookkeeping (like `targetTabId`) — it is **not** added to the
popup-facing `RecordingStatusView`. This is the
[fencing-token pattern](https://martin.kleppmann.com/) (Kleppmann, *Designing
Data-Intensive Applications*, ch. 8–9): a token that lets the receiver reject
writes from a process operating in a stale epoch.

**2. The epoch is assigned by the background and never written back into the
session from offscreen status.** `applyOffscreenPhase` ignores `msg.epoch` and
preserves its own — the echoed epoch exists only so the background fence can match
it. This keeps a single writer for the token.

**3. Keep state transfer, do not switch to event notification.** `OFFSCREEN_STATE`
continues to carry the whole phase (event-carried state transfer, in Fowler's
taxonomy), which is idempotent and self-contained. Switching the offscreen to emit
*events* the background folds into phase would *increase* coupling (missed-event
handling, reconstruction) for no gain here; versioned state transfer is the lighter
correct option.

**4. Separate desired-state from observed-state (implemented 2026-06-16).** The
root cause is the conflation of intent and observation into one field. The session
now stores two planes — `desired` (command-plane intent, `idle`/`recording`,
written only by `start`/`stop`) and `observed` (status-plane, the offscreen's last
reported state, written only by `applyOffscreenPhase`) — plus a terminal `failed`
flag, and the displayed phase is a pure projection
`phase = projectPhase(desired, observed, failed)` (`shared/recordingProjection.ts`).
`starting`/`stopping` are now *derived* ("intent says go, observation hasn't caught
up" / "intent says stop, capture still draining"). This is the Kubernetes
`spec`/`status` (reconciliation) shape and applies the single-writer principle per
field.

The concrete payoff is *within-run* intent preservation that the fence alone cannot
give: after a stop (`desired=idle`), a late **same-run** `recording` re-broadcast
(e.g. an offscreen reconnect) derives to `stopping` instead of clobbering back to
`recording`. **Cross-run** staleness — including a stale `idle` — remains the epoch
fence's job (Decision 1): it drops mismatched-epoch status before it reaches the
session, so a same-run `idle` is always a genuine end-of-run and finalizes
unconditionally (including an autonomous offscreen stop). The fence and the split
are therefore complementary, not redundant — an earlier framing that "a late
`observed=idle` cannot clobber anything by construction" over-credited the split;
idle clobbering is the fence's responsibility. Backward compatible:
`normalizeSessionSnapshot` reconstructs the planes from a legacy persisted `phase`.

## Alternatives considered

- **A legal-transition table that rejects illegal transitions inside
  `RecordingSession`.** Rejected as the primary mechanism: it solves a
  concurrency/ordering problem (a stale message) with domain-logic rejection (the
  wrong layer), risks wedging the phase if the table is even slightly too strict,
  and preserves the intent/observed conflation (you keep discovering new "illegal"
  pairs to add). A guarded transition is still worthwhile later as a **logged
  defense-in-depth assertion** (reject physically-impossible transitions, emit a
  diagnostic) — but not as the fix.
- **Full event sourcing / CQRS.** Sound but disproportionate: the offscreen still
  needs local phase state (it gates orphan recovery and rebaselines the lag clock),
  and the protocol/test surface is large for the size of the problem.

## Consequences

- The narrow `starting → idle` guard in `background.ts` is replaced by the general
  epoch fence; the documented transition diagram is no longer the only line of
  defense against stale status.
- `OFFSCREEN_START` and `OFFSCREEN_STATE` gain an `epoch` field; the session
  snapshot gains a persisted `epoch`. Backward compatible: a persisted snapshot
  without an epoch rehydrates with `epoch` undefined and the fence stays inert
  until the first `start()`.
- The intent/observed split (Decision 4) is now implemented: the displayed `phase`
  is derived from `desired`/`observed`/`failed`, `applyOffscreenPhase` writes only
  the status plane, and the dead `markRecording`/`markUploading` setters were
  removed. The epoch fence (Decision 1) and the phase watchdog remain as the
  cross-run and liveness complements described above.

**Liveness complement (implemented).** The fence drops *stale* status; it does
nothing for *missing* status — a session orphaned in `starting` (worker died
mid-start) or `stopping` (worker died mid-stop) when the in-flight `OFFSCREEN_START`
/ `OFFSCREEN_STOP` RPC promise is lost and the offscreen reconnect re-broadcast is
itself fenced out by the stale epoch, so nothing drives the session on. A small
background **phase watchdog** (`background/phaseWatchdog.ts`) closes that gap with a
per-phase budget map (`TIMEOUTS.STARTING_WATCHDOG_MS` / `STOPPING_WATCHDOG_MS`):
armed from the session change-listener (including the rehydrated transition, so it
fires immediately for an already-stale phase), it fails the session and tears down
the offscreen on timeout so a retry starts clean. It is deliberately above `RPC_MS`
(a slow-but-live start/stop fails through its own RPC timeout first) and watches
exactly the orphan-prone "intent ≠ observed" phases — `starting` and `stopping`;
`uploading` legitimately runs for minutes and has its own orphan-file recovery, and
a stuck `stopping` keeps its captured file (recovered separately) so its failure
message says as much. This *is* the reconciler escalation rule Decision 4 enables —
generalized from "stuck in `starting`" to "intent unmet for too long".
