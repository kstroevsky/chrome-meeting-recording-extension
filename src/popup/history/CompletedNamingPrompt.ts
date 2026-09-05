/**
 * @file popup/history/CompletedNamingPrompt.ts
 *
 * Asks for a name once an upload has finished, one recording at a time.
 *
 * The queue matters. Several runs can complete while the popup is closed, and
 * the prompt must not stack: `pending` holds the job being asked about, and the
 * next one is only raised after the current answer lands. It also stays quiet
 * during a run — naming a recording mid-capture would sit on top of the very
 * screen the user opened the popup for.
 *
 * A skipped name is a real answer, told to the background, so the same
 * recording is never asked about twice.
 *
 * The same prompt offers the Drive destination, because naming is the one
 * moment the user is already thinking about what the recording was. Skipping
 * leaves it in the built-in folder rather than guessing a destination.
 */

import type { RecordingNameDialog } from '../RecordingNameDialog';
import { sendToBackground } from '../../shared/messages';
import type { DriveFolderPreset } from '../../shared/settings';
import type { RecordingPhase, RecordingStatusView, UploadJob } from '../../shared/recording';

export type CompletedNamingActions = {
  notify: (message: string) => void;
  /** Renames through the caller, which owns the session the response carries. */
  rename: (historyId: string, name: string) => Promise<unknown>;
  /** Destinations offered in the prompt; empty until settings load, or when none exist. */
  destinations: () => DriveFolderPreset[];
  /** Files the recording's Drive folder into the chosen destination. */
  fileTo: (historyId: string, presetId: string) => Promise<unknown>;
  applySession: (session: RecordingStatusView) => void;
  /** Brings the job being named into view before its prompt appears. */
  reveal: (jobId: string) => void;
  /** The phase/session to re-check once an answer lands. */
  latest: () => { phase: RecordingPhase; session?: RecordingStatusView };
  /** True while the popup is a static preview or torn down — never prompt then. */
  suspended: () => boolean;
};

export class CompletedNamingPrompt {
  /** The job currently being asked about; blocks a second prompt. */
  private pending: string | null = null;

  constructor(
    private readonly dialog: RecordingNameDialog,
    private readonly actions: CompletedNamingActions,
  ) {}

  /** Schedules after the current render, avoiding recursive tab selection. */
  queue(phase: RecordingPhase, session?: RecordingStatusView): void {
    if (this.actions.suspended()) return;
    queueMicrotask(() => void this.openNext(phase, session));
  }

  private async openNext(phase: RecordingPhase, session?: RecordingStatusView): Promise<void> {
    if (this.actions.suspended() || this.pending || this.dialog.isOpen()) return;
    // A run in progress owns the screen; naming waits for it to finish.
    if (phase === 'starting' || phase === 'recording' || phase === 'stopping') return;
    const job = nextUnnamed(session?.uploadJobs);
    if (!job?.historyId) return;

    this.pending = job.id;
    this.actions.reveal(job.id);
    const presets = this.actions.destinations();
    try {
      const outcome = await this.dialog.ask({
        title: 'Name this recording',
        message: 'The recording folder and every uploaded media file will use this name.',
        initialValue: job.label,
        saveLabel: 'Save name',
        cancelLabel: 'Skip',
        destinations: presets.length
          ? { presets, unfiledLabel: 'Google Meet Records', initialId: null }
          : undefined,
        onSave: async (name, destinationId) => {
          // Rename first: filing moves the folder this rename just retitled,
          // and a failed move must not cost the user the name they typed.
          await this.actions.rename(job.historyId!, name);
          if (destinationId) await this.actions.fileTo(job.historyId!, destinationId);
        },
      });
      if (outcome === 'canceled') {
        // Skipping is recorded, so this recording is not asked about again.
        const response = await sendToBackground({ type: 'SKIP_RECORDING_NAMING', jobId: job.id });
        if (response.ok === false) throw new Error(response.error || 'Could not skip recording naming');
        if (response.session) this.actions.applySession(response.session);
      }
    } catch (error) {
      this.actions.notify(error instanceof Error ? error.message : 'Could not update recording name');
    } finally {
      this.pending = null;
      const { phase: latestPhase, session: latestSession } = this.actions.latest();
      this.queue(latestPhase, latestSession);
    }
  }
}

/** The earliest finished upload still waiting for a name. */
function nextUnnamed(jobs: UploadJob[] | undefined): UploadJob | undefined {
  return [...(jobs ?? [])]
    .filter((job) => job.status === 'completed' && job.namingStatus === 'pending' && !!job.historyId)
    .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt))[0];
}
