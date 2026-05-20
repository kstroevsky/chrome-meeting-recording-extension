/**
 * @file content/MeetingEndDetector.ts
 *
 * Conservative Google Meet end detector used only as an automatic stop signal.
 */

import { TIMEOUTS } from '../shared/timeouts';
import type { MeetingProviderAdapter, MeetingLifecycleState } from './MeetingProviderAdapter';

export type MeetingEndedPayload = {
  meetingId: string | null;
  reason: string;
};

export type MeetingEndDetectorDeps = {
  provider: MeetingProviderAdapter;
  getMeetingId: () => string | null;
  onMeetingEnded: (payload: MeetingEndedPayload) => void;
  root?: Document;
};

export class MeetingEndDetector {
  private readonly root: Document;
  private observer: MutationObserver | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private hasSeenActiveMeeting = false;
  private reported = false;
  private pendingReason = '';

  constructor(private readonly deps: MeetingEndDetectorDeps) {
    this.root = deps.root ?? document;
  }

  start(): void {
    this.stop();
    this.reported = false;
    this.hasSeenActiveMeeting = false;
    this.evaluate();

    this.observer = new MutationObserver(() => this.evaluate());
    this.observer.observe(this.root.body, { childList: true, subtree: true, characterData: true });
    this.pollTimer = setInterval(() => this.evaluate(), TIMEOUTS.MEETING_END_POLL_MS);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.cancelPendingEnd();
  }

  private evaluate(): void {
    if (this.reported) return;

    const state = this.deps.provider.getMeetingLifecycleState(this.root);
    if (state === 'active') {
      this.hasSeenActiveMeeting = true;
      this.cancelPendingEnd();
      return;
    }

    if (!this.hasSeenActiveMeeting) return;

    this.scheduleEnd(state === 'ended' ? 'post-call state detected' : 'meeting controls disappeared');
  }

  private scheduleEnd(reason: string): void {
    if (this.graceTimer) {
      this.pendingReason = reason;
      return;
    }

    this.pendingReason = reason;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.confirmEnd();
    }, TIMEOUTS.MEETING_END_GRACE_MS);
  }

  private confirmEnd(): void {
    if (this.reported || !this.hasSeenActiveMeeting) return;
    const state: MeetingLifecycleState = this.deps.provider.getMeetingLifecycleState(this.root);
    if (state === 'active') return;

    this.reported = true;
    this.deps.onMeetingEnded({
      meetingId: this.deps.getMeetingId(),
      reason: state === 'ended' ? 'post-call state detected' : this.pendingReason,
    });
  }

  private cancelPendingEnd(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.pendingReason = '';
  }
}
