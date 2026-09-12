/**
 * @file background/RecordingTranscriptCapture.ts
 *
 * Turns the meeting tab's live captions into a recording's stored transcript.
 *
 * The content script sees words on a wall clock and knows nothing about
 * recordings; the session knows the media timeline but never sees a caption.
 * This is the seam between them, and it is the only place the two clocks meet
 * (ADR-0007 Decision 1).
 *
 * **Why push, and why also pull.** Captions live only in the meeting tab's
 * memory, and that tab can close before — or during — finalize, so utterances
 * are shipped as they commit rather than collected at stop. That push has to be
 * armed, or every Meet call with captions on would wake the service worker every
 * few seconds whether or not anything is being recorded.
 *
 * Arming would leave a gap — a content script that loads *after* the run began,
 * on a Meet reload or navigation, never receives the arming message — so a
 * fresh script asks {@link captureState} whether it should be shipping, and
 * arms itself from the answer. That keeps the pipeline incremental for the rest
 * of the run instead of deferring everything to the end. The run-end sweep
 * remains as reconciliation, not as the recovery path.
 *
 * **Every push names its run.** A message delayed across a stop/start boundary
 * would otherwise file one run's words under the next one, so pushes carry the
 * session's fencing token (ADR-0003) and a mismatched one is dropped.
 *
 * Everything here is best-effort. A transcript is a derived convenience; failing
 * to record one must never disturb the capture it describes.
 */

import { toTranscriptSegments, type CaptionUtterance, type MediaRangeProjector } from '../shared/transcript';
import type { RecordingTranscriptService } from './RecordingTranscriptService';

export type RecordingTranscriptCaptureDeps = {
  transcripts: RecordingTranscriptService;
  /** The run's history id, or `undefined` when nothing is recording. */
  activeHistoryId: () => string | undefined;
  /** The run's fencing token, or `undefined` when nothing is recording. */
  activeRunId: () => number | undefined;
  /**
   * Projects an utterance's spoken span onto the media timeline. Backed by
   * `RecordingSession.recordedRangeAt`, which keeps working after the run has
   * ended — which is when {@link RecordingTranscriptCapture.finish} needs it.
   */
  recordedRangeAt: MediaRangeProjector;
  sendToTab: (tabId: number, message: unknown) => Promise<unknown>;
  warn: (...args: unknown[]) => void;
};

export class RecordingTranscriptCapture {
  /**
   * The tab armed for the current run.
   *
   * Remembered rather than read from the session, because by the time a run
   * finishes the session has already returned to idle and dropped
   * `targetTabId` — so asking it at sweep time finds nothing to sweep.
   */
  private armedTabId?: number;

  constructor(private readonly deps: RecordingTranscriptCaptureDeps) {}

  /** Arms the meeting tab's push for a run that is starting. */
  async arm(tabId: number, runId: number): Promise<void> {
    this.armedTabId = tabId;
    await this.setCapture(tabId, runId);
  }

  /**
   * Answers a freshly loaded content script asking whether it should be
   * shipping captions. Only a live run with a reachable identity is active.
   */
  captureState(): { active: boolean; runId?: number } {
    const runId = this.deps.activeRunId();
    if (runId == null || !this.deps.activeHistoryId()) return { active: false };
    return { active: true, runId };
  }

  /**
   * Closes the caption buffer on a recording boundary — a pause, or the stop.
   *
   * Draining the tab makes it commit whatever is still inside its grace window,
   * so an utterance ends *at* the boundary and anything after it belongs to the
   * next span or to no recording at all. Without this, a sentence spoken across
   * the boundary arrives as one caption covering a stretch that is not in the
   * media, and no arithmetic can say where its words divide — see
   * `RecordingSession.recordedRangeAt`, which refuses such a caption outright.
   * Draining here is what keeps the common case away from that refusal.
   *
   * Must be called once the span has already closed (after `markStopping`, or
   * after the pause has been mirrored onto the session), so the boundary the
   * utterances are measured against is fixed rather than still moving.
   */
  async flushAtBoundary(historyId: string): Promise<void> {
    if (this.armedTabId == null) return;
    await this.sweep(historyId, this.armedTabId);
  }

  /**
   * Sweeps the tab one last time and disarms it.
   *
   * Called when a run finishes, by which point the session has already returned
   * to idle — so both the recording's identity and the tab to sweep come from
   * here and from {@link arm}, never from the live session.
   */
  async finish(historyId: string): Promise<void> {
    const tabId = this.armedTabId;
    this.armedTabId = undefined;
    if (tabId == null) return;

    await this.sweep(historyId, tabId);
    await this.setCapture(tabId, null);
  }

  /** Drains everything the tab has committed and stores what maps. */
  private async sweep(historyId: string, tabId: number): Promise<void> {
    try {
      const response = await this.deps.sendToTab(tabId, { type: 'GET_TRANSCRIPT_UTTERANCES' });
      const utterances = (response as { utterances?: unknown })?.utterances;
      if (Array.isArray(utterances)) await this.store(historyId, utterances as CaptionUtterance[]);
    } catch (error) {
      // A closed tab is the normal case here, not a fault — everything it had
      // was already pushed.
      this.deps.warn('Could not sweep the meeting tab for its transcript:', error);
    }
  }

  /** Handles a push of committed utterances from the meeting tab. */
  async receive(runId: number, utterances: CaptionUtterance[]): Promise<void> {
    const historyId = this.deps.activeHistoryId();
    // Nothing is recording, so these words belong to no recording. Dropping them
    // is correct: a transcript is keyed to a run.
    if (!historyId) return;
    // A push that survived a stop/start boundary belongs to the run that ended,
    // whose words are already swept. Filing them under this run would corrupt it.
    if (runId !== this.deps.activeRunId()) return;
    await this.store(historyId, utterances);
  }

  /**
   * The single projection path. Both the live push and the end-of-run
   * reconciliation land here, so an utterance converts identically either way
   * — which is what makes the service's content-identity de-duplication exact
   * and lets the durable schema stay free of synthetic ids.
   */
  private async store(historyId: string, utterances: CaptionUtterance[]): Promise<void> {
    const segments = toTranscriptSegments(utterances, this.deps.recordedRangeAt);
    if (segments.length < utterances.length) {
      // Words that map nowhere in the media: spoken outside the run, or across
      // a pause the buffer flush did not close.
      this.deps.warn(`Dropped ${utterances.length - segments.length} caption utterance(s) with no media position`);
    }
    if (!segments.length) return;
    try {
      await this.deps.transcripts.append(historyId, 'meet-captions', segments);
    } catch (error) {
      this.deps.warn('Could not append to the recording transcript:', error);
    }
  }

  private async setCapture(tabId: number, runId: number | null): Promise<void> {
    try {
      await this.deps.sendToTab(tabId, {
        type: 'SET_TRANSCRIPT_CAPTURE',
        active: runId != null,
        ...(runId != null ? { runId } : {}),
      });
    } catch (error) {
      // A tab with no content script — a non-Meet capture — is expected.
      this.deps.warn(`Could not ${runId != null ? 'arm' : 'disarm'} transcript capture:`, error);
    }
  }
}
