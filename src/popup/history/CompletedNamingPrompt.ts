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
 *
 * It is also where the routes picked at Start are confirmed (plan E7): either
 * button releases them once the files are settled, × removes one for this
 * recording, and Escape decides nothing. A recording whose files were saved
 * without a prompt (no folders to choose from, or the popup was closed) is
 * asked about afterwards, only for its routes.
 */

import { formatBytes } from '../../shared/format';
import type {
  RecordingNameDialog,
  RecordingNameDialogOptions,
  RecordingNameDialogOutcome,
  RecordingNameDialogRoutes,
} from '../RecordingNameDialog';
import type { RecordingRouteActions } from './recordingRouteActions';
import { sendToBackground } from '../../shared/messages';
import type { DriveFolderPreset } from '../../shared/settings';
import { DEFAULT_DRIVE_ROOT_FOLDER_NAME, DRIVE_DEFAULT_DESTINATION_NAME } from '../../shared/settings';
import { suffixedRecordingName } from '../../shared/recordingNames';
import type { RecordingPhase, RecordingStatusView, UploadJob } from '../../shared/recording';
import type { PendingLocalDelivery } from '../../shared/recordingHistory';

export type CompletedNamingActions = {
  notify: (message: string) => void;
  /** Renames through the caller, which owns the session the response carries. */
  rename: (historyId: string, name: string) => Promise<unknown>;
  /** Destinations offered in the prompt; empty until settings load, or when none exist. */
  destinations: () => DriveFolderPreset[];
  /** The Drive folder they all live in, so the prompt can say where a recording went. */
  driveRootFolder: () => string;
  /** Adds a folder from the dialog (7A); null when the name was refused. */
  createDestination: (name: string) => Promise<DriveFolderPreset | null>;
  /** Names already in the library, so the prompt can say a name is taken (7C). */
  recordingNames: () => readonly string[];
  /** Files the recording's Drive folder into the chosen destination. */
  fileTo: (historyId: string, presetId: string | null) => Promise<unknown>;
  /** Local folders offered to a recording that has not been written yet. */
  localFolders: () => DriveFolderPreset[];
  /** Local recordings whose bytes are retained but not yet written to Downloads. */
  pendingLocal: () => PendingLocalDelivery[];
  /** Writes one of those into the chosen folder; null means the download directory. */
  deliverLocal: (historyId: string, folderId: string | null) => Promise<unknown>;
  applySession: (session: RecordingStatusView) => void;
  /** Brings the job being named into view before its prompt appears. */
  reveal: (jobId: string) => void;
  /** The phase/session to re-check once an answer lands. */
  latest: () => { phase: RecordingPhase; session?: RecordingStatusView };
  /** True while the popup is a static preview or torn down — never prompt then. */
  suspended: () => boolean;
  /** The routes picked at Start; absent where nothing is routed (previews). */
  routing?: RecordingRouteActions;
};

/** How long a list of recordings waiting for confirmation is trusted before it is asked for again. */
const HELD_REFRESH_MS = 15_000;

export class CompletedNamingPrompt {
  /** The job currently being asked about; blocks a second prompt. */
  private pending: string | null = null;
  /** Local recordings already offered, so a failed delivery is not re-offered forever. */
  private readonly attemptedLocal = new Set<string>();
  /** Recordings asked about only for their routes in this popup, answered or not. */
  private readonly attemptedHeld = new Set<string>();
  private held: { at: number; recordings: Awaited<ReturnType<RecordingRouteActions['held']>> } | null = null;
  private lastPhase: RecordingPhase | null = null;

  constructor(
    private readonly dialog: RecordingNameDialog,
    private readonly actions: CompletedNamingActions,
  ) {}

  /** Schedules after the current render, avoiding recursive tab selection. */
  queue(phase: RecordingPhase, session?: RecordingStatusView): void {
    if (this.actions.suspended()) return;
    // A run that just ended may have saved files without asking: look again.
    if (phase === 'idle' && this.lastPhase !== null && this.lastPhase !== 'idle') this.held = null;
    this.lastPhase = phase;
    queueMicrotask(() => void this.openNext(phase, session));
  }

  /**
   * The same prompt for a recording saved to this computer. It runs before the
   * file is written, because a download cannot be moved afterwards — so here
   * the name *becomes* the filename and the folder decides where it lands,
   * where the Drive prompt renames and moves things that already exist.
   */
  private async openNextLocal(): Promise<void> {
    const next = this.actions.pendingLocal().find((entry) => !this.attemptedLocal.has(entry.id));
    if (!next) {
      await this.openNextHeld();
      return;
    }
    // Remembered before the attempt, not after: a delivery that fails leaves the
    // recording pending, and re-offering it immediately would spin the prompt.
    this.attemptedLocal.add(next.id);

    this.pending = next.id;
    const presets = this.actions.localFolders();
    try {
      const routes = await this.routesFor(next.id);
      // The local prompt really is the save (9L): the name becomes the file.
      const outcome = await this.dialog.ask({
        duplicateOf: (name) => suffixedRecordingName(name, this.actions.recordingNames()),
        title: 'Save recording',
        message: presets.length ? '' : 'Saved to Downloads',
        initialValue: next.name,
        saveLabel: 'Save recording',
        cancelLabel: 'Keep the default name',
        destinations: presets.length
          // The folder the Save to destination files into starts selected.
          ? { presets, unfiledLabel: 'Downloads', initialId: presets.some((preset) => preset.id === next.folderId) ? next.folderId! : null }
          : undefined,
        ...(routes.options ? { routes: routes.options } : {}),
        onSave: async (name, folderId) => {
          // Rename first: the name is the filename, so it has to be settled
          // before the bytes are written.
          await this.actions.rename(next.id, name);
          await this.actions.deliverLocal(next.id, folderId);
        },
      });
      // Skipping still writes the file — to the download directory, as before
      // destinations existed. Leaving it unwritten would be losing it.
      if (outcome !== 'saved') await this.actions.deliverLocal(next.id, null);
      // Only once the files are written: data is not released for a recording
      // whose files were not saved.
      if (routes.options) await this.confirmRoutes(next.id, outcome, routes.decisions());
    } catch (error) {
      this.actions.notify(error instanceof Error ? error.message : 'Could not save this recording');
    } finally {
      this.pending = null;
      // Several runs can finish before anyone answers; ask about the next.
      const { phase, session } = this.actions.latest();
      this.queue(phase, session);
    }
  }

  /**
   * A finished recording whose files were saved without a prompt, asked about
   * only for where its data goes. Once per popup: a dismissed one waits for the
   * next time the popup opens rather than reopening at once.
   */
  private async openNextHeld(): Promise<void> {
    const routing = this.actions.routing;
    if (!routing) return;
    if (!this.held || Date.now() - this.held.at > HELD_REFRESH_MS) {
      try {
        this.held = { at: Date.now(), recordings: await routing.held() };
      } catch {
        this.held = { at: Date.now(), recordings: [] };
      }
    }
    // The list was fetched asynchronously; something else may have opened meanwhile.
    if (this.actions.suspended() || this.pending || this.dialog.isOpen()) return;
    const next = this.held.recordings.find((recording) => recording.routes.length && !this.attemptedHeld.has(recording.recordingId));
    if (!next) return;
    this.attemptedHeld.add(next.recordingId);

    this.pending = next.recordingId;
    let removed: string[] = [];
    let routeItems = next.routes;
    try {
      const outcome = await this.dialog.ask({
        title: 'Confirm where this recording goes',
        message: 'Its files are saved. Nothing has been sent yet.',
        initialValue: next.name,
        saveLabel: 'Save',
        cancelLabel: 'Keep this name',
        duplicateOf: (name) => (name === next.name ? null : suffixedRecordingName(name, this.actions.recordingNames())),
        routes: {
          items: routeItems,
          onChange: (ids) => { removed = ids; },
          onRetry: async () => (routeItems = await routing.retry(next.recordingId)),
        },
        onSave: async (name) => {
          if (name !== next.name) await this.actions.rename(next.recordingId, name);
        },
      });
      await this.confirmRoutes(next.recordingId, outcome, routeDecisions(routeItems, removed));
    } catch (error) {
      this.actions.notify(error instanceof Error ? error.message : 'Could not confirm where this recording goes');
    } finally {
      this.pending = null;
      const { phase, session } = this.actions.latest();
      this.queue(phase, session);
    }
  }

  /**
   * The route rows for a recording's dialog, and what the user removed there.
   * A failed read shows no rows: the routes stay held, and the recording is
   * asked about again afterwards rather than blocking its name or its files.
   */
  private async routesFor(recordingId: string): Promise<{
    options?: RecordingNameDialogRoutes;
    decisions: () => import('../../integrations/RecordingRoutingService').RecordingRouteDecision[];
  }> {
    const routing = this.actions.routing;
    let removed: string[] = [];
    let items = routing ? await routing.routes(recordingId).catch(() => []) : [];
    if (!routing || !items.length) return { decisions: () => [] };
    return {
      options: {
        items,
        onChange: (ids) => { removed = ids; },
        onRetry: async () => (items = await routing.retry(recordingId)),
      },
      decisions: () => routeDecisions(items, removed),
    };
  }

  /** Either button is an answer about the data; Escape is not. */
  private async confirmRoutes(
    recordingId: string,
    outcome: RecordingNameDialogOutcome,
    decisions: import('../../integrations/RecordingRoutingService').RecordingRouteDecision[],
  ): Promise<void> {
    const routing = this.actions.routing;
    if (!routing || outcome === 'dismissed') return;
    await routing.confirm(recordingId, decisions);
  }

  private driveOptions(job: UploadJob, presets: DriveFolderPreset[]): RecordingNameDialogOptions {
    return driveNamingOptions(job, presets, this.actions.driveRootFolder(), (name) => this.actions.createDestination(name), async (name, destinationId) => {
      // Rename first: filing moves the folder this rename just retitled,
      // and a failed move must not cost the user the name they typed.
      await this.actions.rename(job.historyId!, name);
      if (destinationId !== (job.driveFolderPresetId ?? null)) {
        await this.actions.fileTo(job.historyId!, destinationId);
      }
    }, job.driveFolderPresetId ?? null);
  }

  private async openNext(phase: RecordingPhase, session?: RecordingStatusView): Promise<void> {
    if (this.actions.suspended() || this.pending || this.dialog.isOpen()) return;
    // A run in progress owns the screen; naming waits for it to finish.
    if (phase === 'starting' || phase === 'recording' || phase === 'stopping') return;
    const job = nextUnnamed(session?.uploadJobs);
    if (!job?.historyId) {
      await this.openNextLocal();
      return;
    }

    this.pending = job.id;
    this.actions.reveal(job.id);
    const presets = this.actions.destinations();
    try {
      const routes = await this.routesFor(job.historyId);
      const outcome = await this.dialog.ask({
        ...this.driveOptions(job, presets),
        ...(routes.options ? { routes: routes.options } : {}),
        duplicateOf: (name) => suffixedRecordingName(name, this.actions.recordingNames()),
      });
      if (outcome !== 'saved') {
        // Skipping is recorded, so this recording is not asked about again.
        const response = await sendToBackground({ type: 'SKIP_RECORDING_NAMING', jobId: job.id });
        if (response.ok === false) throw new Error(response.error || 'Could not skip recording naming');
        if (response.session) this.actions.applySession(response.session);
      }
      if (routes.options) await this.confirmRoutes(job.historyId, outcome, routes.decisions());
    } catch (error) {
      this.actions.notify(error instanceof Error ? error.message : 'Could not update recording name');
    } finally {
      this.pending = null;
      const { phase: latestPhase, session: latestSession } = this.actions.latest();
      this.queue(latestPhase, latestSession);
    }
  }
}

/** A stale dialog can decide only the held rows it actually rendered. */
function routeDecisions(
  items: readonly import('../RecordingNameDialog').RecordingNameDialogRoute[],
  removedDestinationIds: readonly string[],
): import('../../integrations/RecordingRoutingService').RecordingRouteDecision[] {
  const removed = new Set(removedDestinationIds);
  return items.flatMap((route) => route.state === 'held'
    ? [{ destinationId: route.destinationId, action: removed.has(route.destinationId) ? 'skip' as const : 'release' as const }]
    : []);
}

/** A title for the gallery: the Drive prompt with its real copy, and no writes. */
export function previewDriveNaming(job: UploadJob, presets: DriveFolderPreset[], pickedId: string | null = null): RecordingNameDialogOptions {
  // The create row is part of what there is to look at (7A), so the story keeps
  // it — it just mints a folder that lives as long as the story does.
  const options = driveNamingOptions(
    job,
    presets,
    DEFAULT_DRIVE_ROOT_FOLDER_NAME,
    async (name) => ({ id: `preview-${name}`, name }),
    async () => {},
    pickedId,
  );
  return options.destinations ? { ...options, destinations: { ...options.destinations, initialId: pickedId } } : options;
}

function driveNamingOptions(
  job: UploadJob,
  presets: DriveFolderPreset[],
  rootFolderName: string,
  onCreate: ((name: string) => Promise<DriveFolderPreset | null>) | undefined,
  onSave: RecordingNameDialogOptions['onSave'],
  initialDestinationId: string | null = null,
): RecordingNameDialogOptions {
  const media = (job.files ?? []).filter((file) => file.kind !== 'notes');
  const bytes = media.reduce((total, file) => total + (file.bytes ?? 0), 0);
  return {
    title: 'Name this recording',
    // Without folders to choose from, the hint says where it already is (9L).
    message: presets.length ? '' : `Saved to Drive > ${rootFolderName} > ${DRIVE_DEFAULT_DESTINATION_NAME}`,
    summary: media.length
      ? [`${media.length} ${media.length === 1 ? 'FILE' : 'FILES'}`, ...(bytes ? [formatBytes(bytes).toUpperCase()] : [])].join(' · ')
      : undefined,
    initialValue: job.label,
    saveLabel: 'Save name',
    cancelLabel: 'Keep the default name',
    destinations: presets.length
      ? {
        presets,
        unfiledLabel: DRIVE_DEFAULT_DESTINATION_NAME,
        initialId: presets.some((preset) => preset.id === initialDestinationId) ? initialDestinationId : null,
        ...(onCreate ? { onCreate } : {}),
      }
      : undefined,
    onSave,
  };
}

/** The earliest finished upload still waiting for a name. */
function nextUnnamed(jobs: UploadJob[] | undefined): UploadJob | undefined {
  return [...(jobs ?? [])]
    .filter((job) => job.status === 'completed' && job.namingStatus === 'pending' && !!job.historyId)
    .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt))[0];
}
