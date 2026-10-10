import { slugifyRecordingTitle } from '../shared/recording';
import type { DriveFolderPreset } from '../shared/settings';
import { createListboxSelect, type ListboxSelect } from '../ui/listboxSelect';
import { ModalShell } from '../ui/modalShell';

/**
 * The Drive folder choice offered alongside the name. Omitted entirely by
 * callers that only rename, so the dialog keeps its single-field shape there.
 */
export type RecordingNameDialogDestinations = {
  presets: DriveFolderPreset[];
  /** Reads as the built-in folder, which is where an unfiled recording is. */
  unfiledLabel: string;
  initialId: string | null;
  /**
   * Makes a folder without leaving the dialog (7A), returning it to be selected
   * — or null when the name was refused. Absent hides the row: choosing an
   * existing folder is the point of the picker, and creating one is the
   * secondary thing you can also do from here.
   */
  onCreate?: (name: string) => Promise<DriveFolderPreset | null>;
};

/** One data route of the recording, as the end dialog offers it (plan E7). */
export type RecordingNameDialogRoute = {
  destinationId: string;
  /** Null when the integration was deleted since Start. */
  destinationName: string | null;
  /** Held routes can be removed; ones that could not be scheduled can be retried. */
  state: 'held' | 'not-scheduled';
  includesMedia?: true;
  /** Primary media ownership without snapshot/data delivery. */
  mediaOnly?: true;
};

export type RecordingNameDialogRouteCandidate = {
  destinationId: string;
  destinationName: string;
  /** Choosing this receiver explicitly authorizes video/audio as well as data. */
  includesMedia?: true;
};

export type RecordingNameDialogRouteEditorState = {
  items: RecordingNameDialogRoute[];
  candidates: RecordingNameDialogRouteCandidate[];
};

export type RecordingNameDialogRoutes = {
  items: RecordingNameDialogRoute[];
  /** Enabled receivers that are not already part of this recording's routing history. */
  candidates?: RecordingNameDialogRouteCandidate[];
  /** The destinations the user removed so far, on every change. */
  onChange: (removedDestinationIds: string[]) => void;
  /** Schedules the routes that failed at Start again, returning them as they now are. */
  onRetry?: () => Promise<RecordingNameDialogRoute[]>;
  /** An explicit end-dialog receiver choice; `undefined` adds rather than replaces. */
  onReplace?: (
    fromDestinationId: string | undefined,
    toDestinationId: string,
  ) => Promise<RecordingNameDialogRouteEditorState>;
};

export type RecordingNameDialogOptions = {
  title: string;
  /** The hint under the name field: where the recording lives, or what naming does. */
  message: string;
  /** The mono line under the title — `4:12 · 3 FILES · 63 MB` (9L, 7F). */
  summary?: string;
  initialValue: string;
  saveLabel?: string;
  cancelLabel?: string;
  destinations?: RecordingNameDialogDestinations;
  /**
   * The name this one would take because that name is already used, or null
   * when it is free (7C). Saving keeps both, so this warns rather than blocks —
   * and the name it returns is the one actually saved.
   */
  duplicateOf?: (name: string) => string | null;
  /** Where the recording's data goes once this dialog is answered (*Will send to … ×*). */
  routes?: RecordingNameDialogRoutes;
  /** Receives the destination the user picked, or null for the built-in folder. */
  onSave: (name: string, destinationId: string | null) => Promise<void>;
};

/**
 * `canceled` is the quiet button; `dismissed` is Escape, the backdrop or a
 * teardown. Only the two buttons are an answer about where the data goes.
 */
export type RecordingNameDialogOutcome = 'saved' | 'canceled' | 'dismissed';

/** The design's save glyph (9L): a disk, drawn in the saved green. */
const SAVE_ICON = '<svg viewBox="0 0 22 22" fill="none"><path d="M5.2 4h8.4L18 8.4v9.1a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 17.5v-12A1.5 1.5 0 015.5 4M7.4 4v4.6h6.2V4.4M7.4 14.4h7.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The name is required, and the dialog says so as soon as the field empties (7B). */
const BLANK_NAME = 'Give the recording a name to save it.';

type DialogParts = {
  shell: ModalShell;
  summary: HTMLElement;
  input: HTMLInputElement;
  destinationRow: HTMLElement;
  destinationSelect: ListboxSelect;
  routes: HTMLElement;
  /** The 7C line: what the name would become, because that one is taken. */
  taken: HTMLElement;
  error: HTMLElement;
  saveBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
};

/** Accessible text-input modal used by automatic and later recording renames. */
export class RecordingNameDialog {
  private parts: DialogParts | null = null;
  private pending: {
    promise: Promise<RecordingNameDialogOutcome>;
    settle: (outcome: RecordingNameDialogOutcome) => void;
    options: RecordingNameDialogOptions;
  } | null = null;
  private busy = false;
  private routeItems: RecordingNameDialogRoute[] = [];
  private routeCandidates: RecordingNameDialogRouteCandidate[] = [];
  private readonly removedRoutes = new Set<string>();
  private retrying = false;
  /** `undefined` = closed, `null` = add a receiver, string = replace that receiver. */
  private changingRoute: string | null | undefined;
  private routeChanging = false;

  constructor(private readonly doc: Document = document) {}

  isOpen = (): boolean => this.pending !== null;

  ask(options: RecordingNameDialogOptions): Promise<RecordingNameDialogOutcome> {
    if (this.pending) return this.pending.promise;
    const parts = this.parts ?? (this.parts = this.build());
    parts.shell.title.textContent = options.title;
    parts.shell.message.textContent = options.message;
    parts.shell.message.hidden = !options.message;
    parts.summary.textContent = options.summary ?? '';
    parts.summary.hidden = !options.summary;
    parts.input.value = options.initialValue;
    parts.saveBtn.textContent = options.saveLabel ?? 'Save name';
    parts.cancelBtn.textContent = options.cancelLabel ?? 'Skip';
    this.fillDestinations(parts, options.destinations);
    this.routeItems = options.routes?.items.slice() ?? [];
    this.routeCandidates = options.routes?.candidates?.slice() ?? [];
    this.removedRoutes.clear();
    this.changingRoute = undefined;
    this.routeChanging = false;
    this.showError();
    this.setBusy(false);

    let settle!: (outcome: RecordingNameDialogOutcome) => void;
    const promise = new Promise<RecordingNameDialogOutcome>((resolve) => { settle = resolve; });
    this.pending = { promise, settle, options };
    this.renderRoutes();
    // After `pending`, because the check it runs lives on the open request.
    this.syncDuplicate();
    parts.shell.open(parts.input);
    parts.input.select();
    return promise;
  }

  dismiss = (): void => this.close('dismissed');

  dispose(): void {
    this.setBusy(false);
    this.close('canceled');
    this.parts?.destinationSelect.destroy();
    this.parts?.shell.destroy();
    this.parts = null;
  }

  private async submit(): Promise<void> {
    const pending = this.pending;
    const parts = this.parts;
    if (!pending || !parts || this.busy || this.routeChanging) return;
    const typed = parts.input.value.trim();
    const destinationId = pending.options.destinations ? parts.destinationSelect.getValue() || null : null;
    if (!typed) { this.showError(BLANK_NAME); return; }
    if (!slugifyRecordingTitle(typed)) { this.showError('Use at least one letter or number'); return; }
    // The warning said what this would become; saving has to keep that promise.
    const name = pending.options.duplicateOf?.(typed) ?? typed;

    this.showError();
    this.setBusy(true);
    try {
      await pending.options.onSave(name, destinationId);
      this.setBusy(false);
      this.close('saved');
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
      this.setBusy(false);
      parts.input.focus();
    }
  }

  private close(outcome: RecordingNameDialogOutcome): void {
    const pending = this.pending;
    if (!pending || this.busy) return;
    this.pending = null;
    if (this.parts) {
      this.parts.destinationSelect.close();
      this.parts.shell.close();
    }
    pending.settle(outcome);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.syncInteractionLock();
    if (!this.parts) return;
    this.parts.saveBtn.textContent = busy ? 'Saving…' : (this.pending?.options.saveLabel ?? this.parts.saveBtn.textContent);
  }

  /** A route mutation is atomic from the person's point of view, so the dialog cannot close midway through it. */
  private setRouteChanging(changing: boolean): void {
    this.routeChanging = changing;
    this.syncInteractionLock();
    if (!changing && this.parts && !this.parts.input.value.trim()) this.parts.saveBtn.disabled = true;
  }

  private syncInteractionLock(): void {
    if (!this.parts) return;
    // Saving or changing a receiver must not be dismissable by Escape/backdrop:
    // otherwise a stale answer could race the explicit authorization change.
    const locked = this.busy || this.routeChanging;
    this.parts.shell.setLocked(locked);
    this.parts.input.disabled = locked;
    this.parts.destinationSelect.setDisabled(locked);
    this.parts.saveBtn.disabled = locked;
    this.parts.cancelBtn.disabled = locked;
    for (const button of Array.from(this.parts.routes.querySelectorAll('button'))) {
      button.disabled = locked || this.retrying;
    }
  }

  private showError(message = ''): void {
    if (!this.parts) return;
    this.parts.error.textContent = message;
    this.parts.error.hidden = !message;
    this.parts.input.setAttribute('aria-invalid', String(!!message));
    // The hint and the error share the line under the field; the error wins it.
    this.parts.shell.message.classList.toggle('recording-name-hint--replaced', Boolean(message));
  }

  /** An empty field blocks the save as it happens, rather than on the click (7B). */
  private syncBlank(): void {
    if (!this.parts || this.busy || this.routeChanging) return;
    const blank = !this.parts.input.value.trim();
    this.parts.saveBtn.disabled = blank;
    this.showError(blank ? BLANK_NAME : '');
    if (!blank) this.syncDuplicate();
  }

  /**
   * Says what the name would become, as it is typed (7C).
   *
   * A warning, not an error: the save stays enabled and the field keeps the
   * caution tone rather than the refusal one, because nothing here is wrong —
   * two recordings are simply allowed to share a name.
   */
  private syncDuplicate(): void {
    const parts = this.parts;
    const pending = this.pending;
    if (!parts || !pending) return;
    const typed = parts.input.value.trim();
    const becomes = typed ? pending.options.duplicateOf?.(typed) ?? null : null;
    parts.input.classList.toggle('recording-name-input--taken', Boolean(becomes));
    parts.taken.hidden = !becomes;
    if (!becomes) { parts.taken.replaceChildren(); return; }
    const lead = this.doc.createTextNode('That name is taken. Saving keeps both — this one becomes ');
    const name = this.doc.createElement('span');
    name.className = 'recording-name-taken__name';
    name.textContent = becomes;
    parts.taken.replaceChildren(lead, name, this.doc.createTextNode('.'));
  }

  private build(): DialogParts {
    const shell = new ModalShell({
      doc: this.doc,
      idPrefix: 'recording-name-modal',
      overlayClass: 'recording-name-overlay',
      cardClass: 'recording-name-card',
      iconClass: 'recording-name-icon',
      iconSvg: SAVE_ICON,
      onDismiss: () => this.close('dismissed'),
    });
    // Head row (9L): the icon beside the title and the recording's mono summary.
    const summary = this.doc.createElement('p');
    summary.className = 'recording-name-summary';
    summary.hidden = true;
    shell.title.after(summary);
    shell.message.classList.add('recording-name-hint');
    const label = (text: string) => {
      const node = this.doc.createElement('div');
      node.className = 'recording-name-label';
      node.textContent = text;
      return node;
    };

    const input = this.doc.createElement('input');
    input.className = 'recording-name-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Recording name');
    input.setAttribute('aria-describedby', 'recording-name-modal-error');

    const destinationRow = this.doc.createElement('div');
    destinationRow.className = 'recording-name-destination';
    destinationRow.hidden = true;
    const destinationLabel = this.doc.createElement('span');
    destinationLabel.className = 'recording-name-label';
    destinationLabel.textContent = 'FOLDER';
    const destinationSelect = createListboxSelect({
      label: 'Google Drive destination',
      className: 'recording-name-destination__select',
      // A long list gains a search row (7D); a short one stays a plain list (9FD).
      search: { minOptions: 8, placeholder: 'Search folders', noun: 'FOLDERS' },
      // The last row makes a folder rather than choosing one (7A). It reads the
      // handler off the open request, because the control outlives each ask.
      create: {
        label: 'New folder\u2026',
        placeholder: 'Folder name',
        onCreate: async (name) => {
          const make = this.pending?.options.destinations?.onCreate;
          const preset = await make?.(name);
          return preset ? { value: preset.id, label: preset.name } : null;
        },
      },
      options: [],
      onChange: () => {},
      doc: this.doc,
    });
    destinationRow.append(destinationLabel, destinationSelect.root);

    // Under the field, in the caution tone: a note about what will happen, not
    // a complaint about what was typed.
    const taken = this.doc.createElement('p');
    taken.className = 'recording-name-taken';
    taken.hidden = true;

    // Where the data goes (E7): one row per route, between the fields and the buttons.
    const routes = this.doc.createElement('div');
    routes.className = 'recording-name-routes';
    routes.setAttribute('role', 'group');
    routes.setAttribute('aria-label', 'Where the recording is sent');
    routes.hidden = true;

    const error = this.doc.createElement('p');
    error.className = 'recording-name-error';
    error.id = 'recording-name-modal-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;

    const saveBtn = this.doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-ink';
    saveBtn.dataset.recordingNameSave = '';
    // The way out is a quiet text action, not a second button (9L, 7F).
    const cancelBtn = this.doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'recording-name-skip';
    cancelBtn.dataset.recordingNameCancel = '';
    shell.actions.append(saveBtn, cancelBtn);
    // The hint sits under the field it explains; an error takes its line.
    shell.body.append(label('NAME'), input, shell.message, taken, error, destinationRow, routes);

    saveBtn.addEventListener('click', () => void this.submit());
    cancelBtn.addEventListener('click', () => this.close('canceled'));
    input.addEventListener('input', () => this.syncBlank());
    // Escape, the backdrop and the Tab trap belong to the shell; Enter-to-save
    // is this dialog's own, and must run before the shell sees the key.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void this.submit(); }
    });

    return { shell, summary, input, destinationRow, destinationSelect, routes, taken, error, saveBtn, cancelBtn };
  }

  /** Hidden unless the caller offers destinations, so a plain rename is unchanged. */
  private fillDestinations(parts: DialogParts, destinations?: RecordingNameDialogDestinations): void {
    parts.destinationRow.hidden = !destinations;
    if (!destinations) {
      parts.destinationSelect.setOptions([]);
      return;
    }
    parts.destinationSelect.setCreateEnabled(Boolean(destinations.onCreate));
    parts.destinationSelect.setOptions([
      { value: '', label: destinations.unfiledLabel },
      ...destinations.presets.map((preset) => ({ value: preset.id, label: preset.name })),
    ], destinations.initialId ?? '');
  }

  /**
   * The route rows (E7). A held route reads *Will send to X* with an × that
   * removes it for this recording only, and an Undo to take that back; a route
   * that could not be scheduled at Start says so and offers a retry, because
   * the dialog must not pretend the send was planned.
   */
  private renderRoutes(): void {
    const parts = this.parts;
    if (!parts) return;
    const canChange = Boolean(this.pending?.options.routes?.onReplace && this.routeCandidates.length);
    parts.routes.hidden = this.routeItems.length === 0 && !canChange;
    const rows: HTMLElement[] = [];
    for (const route of this.routeItems) {
      const row = this.doc.createElement('div');
      row.className = 'recording-name-route';
      row.dataset.routeState = route.state;
      row.dataset.destinationId = route.destinationId;
      const text = this.doc.createElement('span');
      text.className = 'recording-name-route__text';
      row.appendChild(text);
      const name = route.destinationName;
      if (route.state === 'not-scheduled') {
        row.classList.add('recording-name-route--warn');
        if (!name) {
          text.textContent = 'Its integration was deleted · nothing will be sent';
          rows.push(row);
          continue;
        }
        text.textContent = `Automation for ${name} could not be scheduled`;
        if (this.pending?.options.routes?.onRetry) {
          row.appendChild(this.routeButton(this.retrying ? 'Retrying\u2026' : 'Retry automation', `Retry automation for ${name}`, () => void this.retryRoutes()));
        }
        rows.push(row);
        continue;
      }
      const removed = this.removedRoutes.has(route.destinationId);
      row.classList.toggle('recording-name-route--removed', removed);
      const payload = route.mediaOnly
        ? 'recording video/audio'
        : route.includesMedia ? 'recording video/audio and data' : 'recording data';
      text.textContent = removed
        ? `Won't send ${payload} to ${name ?? 'this integration'}`
        : `Will send ${payload} to ${name ?? 'this integration'}`;
      if (!removed && canChange) {
        row.appendChild(this.routeButton(
          'Change',
          `Change ${name ?? 'this integration'} for this recording`,
          () => this.toggleRoutePicker(route.destinationId),
        ));
      }
      row.appendChild(removed
        ? this.routeButton('Undo', `Send to ${name ?? 'this integration'} after all`, () => this.toggleRoute(route.destinationId))
        : this.routeButton('\u00d7', `Don't send to ${name ?? 'this integration'}`, () => this.toggleRoute(route.destinationId), 'recording-name-route__remove'));
      rows.push(row);
      if (!removed && this.changingRoute === route.destinationId) rows.push(this.routePicker(route.destinationId));
    }
    if (canChange) {
      const add = this.doc.createElement('div');
      add.className = 'recording-name-route recording-name-route--add';
      const text = this.doc.createElement('span');
      text.className = 'recording-name-route__text';
      text.textContent = this.routeItems.some((route) => route.state === 'held')
        ? 'Send to another service'
        : 'Send recording to a service';
      add.append(text, this.routeButton('Choose', 'Choose another service for this recording', () => this.toggleRoutePicker(null)));
      rows.push(add);
      if (this.changingRoute === null) rows.push(this.routePicker(null));
    }
    parts.routes.replaceChildren(...rows);
  }

  private routeButton(text: string, label: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
    const button = this.doc.createElement('button');
    button.type = 'button';
    button.className = `recording-name-route__action ${extraClass}`.trim();
    button.textContent = text;
    button.setAttribute('aria-label', label);
    button.disabled = this.busy || this.retrying || this.routeChanging;
    button.addEventListener('click', onClick);
    return button;
  }

  private toggleRoute(destinationId: string): void {
    if (this.busy || this.routeChanging) return;
    if (!this.removedRoutes.delete(destinationId)) this.removedRoutes.add(destinationId);
    this.pending?.options.routes?.onChange([...this.removedRoutes]);
    this.renderRoutes();
    // The row was rebuilt; keep the keyboard on it.
    const rows = Array.from(this.parts?.routes.querySelectorAll<HTMLElement>('[data-destination-id]') ?? []);
    rows.find((row) => row.dataset.destinationId === destinationId)?.querySelector('button')?.focus();
  }

  private async retryRoutes(): Promise<void> {
    const retry = this.pending?.options.routes?.onRetry;
    if (!retry || this.retrying || this.busy || this.routeChanging) return;
    this.retrying = true;
    this.renderRoutes();
    try {
      const items = await retry();
      if (this.pending) this.routeItems = items;
      this.showError();
    } catch (error) {
      this.showError(error instanceof Error ? error.message : 'Could not schedule the automation');
    } finally {
      this.retrying = false;
      this.renderRoutes();
    }
  }

  private toggleRoutePicker(fromDestinationId: string | null): void {
    if (this.busy || this.retrying || this.routeChanging) return;
    this.changingRoute = this.changingRoute === fromDestinationId ? undefined : fromDestinationId;
    this.renderRoutes();
    if (this.changingRoute !== undefined) {
      this.parts?.routes.querySelector<HTMLElement>('.recording-name-route-picker button')?.focus();
    }
  }

  private routePicker(fromDestinationId: string | null): HTMLElement {
    const picker = this.doc.createElement('div');
    picker.className = 'recording-name-route-picker';
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', fromDestinationId ? 'Choose replacement service' : 'Choose service');
    const source = fromDestinationId
      ? this.routeItems.find((route) => route.destinationId === fromDestinationId)
      : undefined;
    const mediaOnly = source?.mediaOnly === true;
    for (const candidate of this.routeCandidates) {
      if (mediaOnly && !candidate.includesMedia) continue;
      const button = this.doc.createElement('button');
      button.type = 'button';
      button.className = 'recording-name-route-candidate';
      const name = this.doc.createElement('span');
      name.className = 'recording-name-route-candidate__name';
      name.textContent = candidate.destinationName;
      const disclosure = this.doc.createElement('span');
      disclosure.className = 'recording-name-route-candidate__payload';
      disclosure.textContent = mediaOnly
        ? 'VIDEO/AUDIO ONLY'
        : candidate.includesMedia ? 'VIDEO/AUDIO + DATA' : 'DATA ONLY';
      button.append(name, disclosure);
      button.setAttribute(
        'aria-label',
        `${candidate.destinationName}: ${mediaOnly ? 'video and audio only' : candidate.includesMedia ? 'video, audio and data' : 'data only'}`,
      );
      button.disabled = this.busy || this.retrying || this.routeChanging;
      button.addEventListener('click', () => void this.replaceRoute(fromDestinationId ?? undefined, candidate.destinationId));
      picker.appendChild(button);
    }
    return picker;
  }

  private async replaceRoute(fromDestinationId: string | undefined, toDestinationId: string): Promise<void> {
    const replace = this.pending?.options.routes?.onReplace;
    if (!replace || this.busy || this.retrying || this.routeChanging) return;
    this.setRouteChanging(true);
    this.renderRoutes();
    try {
      const state = await replace(fromDestinationId, toDestinationId);
      if (this.pending) {
        this.routeItems = state.items;
        this.routeCandidates = state.candidates;
        const current = new Set(state.items.map((route) => route.destinationId));
        for (const destinationId of this.removedRoutes) {
          if (!current.has(destinationId)) this.removedRoutes.delete(destinationId);
        }
        this.changingRoute = undefined;
      }
      this.showError();
    } catch (error) {
      this.showError(error instanceof Error ? error.message : 'Could not change where this recording goes');
    } finally {
      this.setRouteChanging(false);
      this.renderRoutes();
      const rows = Array.from(this.parts?.routes.querySelectorAll<HTMLElement>('[data-destination-id]') ?? []);
      rows.find((row) => row.dataset.destinationId === toDestinationId)?.querySelector('button')?.focus();
    }
  }
}
