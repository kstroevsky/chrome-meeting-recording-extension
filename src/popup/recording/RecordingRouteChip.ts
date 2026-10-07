/**
 * @file popup/recording/RecordingRouteChip.ts
 *
 * The line under the recording timer saying where this run's data will go
 * (plan E3): `→ CheekyCheeseIT CRM`. The pick decides what leaves the browser,
 * so it stays visible for the whole run. When the routing could not be written
 * at Start the line says so instead, with *Retry automation* (E7): a recording
 * must not look as if its send was planned when it was not.
 *
 * Shown only for an integration destination; the built-ins route nowhere.
 */

import { isBuiltinRecordingDestinationId } from '../../shared/recordingDestinations';
import { sendToBackground } from '../../shared/messages';
import type { RecordingPhase, RecordingStatusView } from '../../shared/recording';
import type { RecordingRouteView } from '../../integrations/RecordingRoutingService';

export type RecordingRouteChipElements = {
  root: HTMLElement;
  label: HTMLElement;
  retry: HTMLButtonElement;
};

export function findRecordingRouteChip(doc: Document): RecordingRouteChipElements | null {
  const root = doc.getElementById('rec-route');
  const label = doc.getElementById('rec-route-label');
  const retry = doc.getElementById('rec-route-retry');
  return root && label && retry instanceof HTMLButtonElement ? { root, label, retry } : null;
}

type Routes = (retry: boolean) => Promise<RecordingRouteView[]>;

const backgroundRoutes: Routes = async (retry) => {
  // No recording ID: the background answers for the run in progress.
  const response = await sendToBackground(retry ? { type: 'RETRY_RECORDING_ROUTING' } : { type: 'GET_RECORDING_ROUTES' });
  if (response.ok === false) throw new Error(response.error || 'Could not read where this recording goes');
  return response.routes;
};

export class RecordingRouteChip {
  /** The run the line was last read for, so a status tick does not ask again. */
  private shownFor: string | null = null;
  private retrying = false;

  constructor(
    private readonly el: RecordingRouteChipElements | null,
    private readonly routes: Routes = backgroundRoutes,
  ) {
    el?.retry.addEventListener('click', () => void this.retry());
  }

  sync(phase: RecordingPhase, session?: RecordingStatusView): void {
    if (!this.el) return;
    const profileId = session?.runConfig?.destinationProfileId;
    // The routing is written before capture starts, so `recording` is the first phase it can be read in.
    const routed = phase === 'recording' && !!profileId && !isBuiltinRecordingDestinationId(profileId);
    if (!routed) {
      this.shownFor = null;
      this.el.root.hidden = true;
      return;
    }
    const run = `${profileId}:${session?.runningSince ?? ''}`;
    if (this.shownFor === run) return;
    this.shownFor = run;
    void this.load(false);
  }

  private async retry(): Promise<void> {
    if (this.retrying) return;
    this.retrying = true;
    if (this.el) this.el.retry.disabled = true;
    try {
      await this.load(true);
    } finally {
      this.retrying = false;
      if (this.el) this.el.retry.disabled = false;
    }
  }

  private async load(retry: boolean): Promise<void> {
    const el = this.el;
    if (!el) return;
    const run = this.shownFor;
    let routes: RecordingRouteView[];
    try {
      routes = await this.routes(retry);
    } catch {
      // Unknown is not "not scheduled": say nothing rather than raise a false alarm.
      if (!retry) el.root.hidden = true;
      return;
    }
    // The run ended, or another began, while this was in flight.
    if (run !== this.shownFor) return;
    this.render(routes);
  }

  private render(routes: RecordingRouteView[]): void {
    const el = this.el!;
    const sending = routes.filter((route) => route.state === 'held' || route.state === 'released');
    const failed = routes.filter((route) => route.state === 'not-scheduled' && route.destinationName);
    el.root.hidden = !sending.length && !failed.length;
    el.root.classList.toggle('rec-route--warn', failed.length > 0);
    el.retry.hidden = failed.length === 0;
    if (failed.length) {
      el.label.textContent = `Recording for ${names(failed)}, but automation could not be scheduled`;
      return;
    }
    el.label.textContent = `→ ${names(sending)}`;
  }
}

function names(routes: RecordingRouteView[]): string {
  return routes.map((route) => route.destinationName ?? 'a deleted integration').join(', ');
}
