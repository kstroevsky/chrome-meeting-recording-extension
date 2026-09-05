import { slugifyRecordingTitle } from '../shared/recording';
import type { DriveFolderPreset } from '../shared/settings';

/**
 * The Drive folder choice offered alongside the name. Omitted entirely by
 * callers that only rename, so the dialog keeps its single-field shape there.
 */
export type RecordingNameDialogDestinations = {
  presets: DriveFolderPreset[];
  /** Reads as the built-in folder, which is where an unfiled recording is. */
  unfiledLabel: string;
  initialId: string | null;
};

export type RecordingNameDialogOptions = {
  title: string;
  message: string;
  initialValue: string;
  saveLabel?: string;
  cancelLabel?: string;
  destinations?: RecordingNameDialogDestinations;
  /** Receives the destination the user picked, or null for the built-in folder. */
  onSave: (name: string, destinationId: string | null) => Promise<void>;
};

export type RecordingNameDialogOutcome = 'saved' | 'canceled';

type DialogParts = {
  overlay: HTMLElement;
  card: HTMLElement;
  title: HTMLElement;
  message: HTMLElement;
  input: HTMLInputElement;
  destinationRow: HTMLElement;
  destinationSelect: HTMLSelectElement;
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
  private previousFocus: HTMLElement | null = null;
  private busy = false;

  constructor(private readonly doc: Document = document) {}

  isOpen = (): boolean => this.pending !== null;

  ask(options: RecordingNameDialogOptions): Promise<RecordingNameDialogOutcome> {
    if (this.pending) return this.pending.promise;
    const parts = this.parts ?? (this.parts = this.build());
    parts.title.textContent = options.title;
    parts.message.textContent = options.message;
    parts.input.value = options.initialValue;
    parts.saveBtn.textContent = options.saveLabel ?? 'Save name';
    parts.cancelBtn.textContent = options.cancelLabel ?? 'Skip';
    this.fillDestinations(parts, options.destinations);
    this.showError();
    this.setBusy(false);

    const active = this.doc.activeElement;
    this.previousFocus = active instanceof HTMLElement ? active : null;
    let settle!: (outcome: RecordingNameDialogOutcome) => void;
    const promise = new Promise<RecordingNameDialogOutcome>((resolve) => { settle = resolve; });
    this.pending = { promise, settle, options };
    parts.overlay.hidden = false;
    parts.input.focus();
    parts.input.select();
    return promise;
  }

  dismiss = (): void => this.close('canceled');

  dispose(): void {
    this.setBusy(false);
    this.close('canceled');
    this.parts?.overlay.remove();
    this.parts = null;
  }

  private async submit(): Promise<void> {
    const pending = this.pending;
    const parts = this.parts;
    if (!pending || !parts || this.busy) return;
    const name = parts.input.value.trim();
    const destinationId = pending.options.destinations ? parts.destinationSelect.value || null : null;
    if (!name) { this.showError('Recording name cannot be blank'); return; }
    if (!slugifyRecordingTitle(name)) { this.showError('Use at least one letter or number'); return; }

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
    if (this.parts) this.parts.overlay.hidden = true;
    this.previousFocus?.focus();
    this.previousFocus = null;
    pending.settle(outcome);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (!this.parts) return;
    this.parts.input.disabled = busy;
    this.parts.destinationSelect.disabled = busy;
    this.parts.saveBtn.disabled = busy;
    this.parts.cancelBtn.disabled = busy;
    this.parts.saveBtn.textContent = busy ? 'Saving…' : (this.pending?.options.saveLabel ?? this.parts.saveBtn.textContent);
  }

  private showError(message = ''): void {
    if (!this.parts) return;
    this.parts.error.textContent = message;
    this.parts.error.hidden = !message;
    this.parts.input.setAttribute('aria-invalid', String(!!message));
  }

  private build(): DialogParts {
    const overlay = this.doc.createElement('div');
    overlay.className = 'modal-overlay recording-name-overlay';
    overlay.hidden = true;

    const card = this.doc.createElement('div');
    card.className = 'modal-card recording-name-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'recording-name-modal-title');
    card.setAttribute('aria-describedby', 'recording-name-modal-message');

    const icon = this.doc.createElement('span');
    icon.className = 'modal-icon recording-name-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 22 22" fill="none"><path d="M4 15.8V18h2.2L16.9 7.3l-2.2-2.2L4 15.8zM13.8 6l2.2 2.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const title = this.doc.createElement('h2');
    title.className = 'modal-title';
    title.id = 'recording-name-modal-title';
    const message = this.doc.createElement('p');
    message.className = 'modal-message';
    message.id = 'recording-name-modal-message';

    const input = this.doc.createElement('input');
    input.className = 'recording-name-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Recording name');
    input.setAttribute('aria-describedby', 'recording-name-modal-error');

    const destinationRow = this.doc.createElement('label');
    destinationRow.className = 'recording-name-destination';
    destinationRow.hidden = true;
    const destinationLabel = this.doc.createElement('span');
    destinationLabel.className = 'recording-name-destination__label';
    destinationLabel.textContent = 'Save to';
    const destinationSelect = this.doc.createElement('select');
    destinationSelect.className = 'recording-name-destination__select';
    destinationRow.append(destinationLabel, destinationSelect);

    const error = this.doc.createElement('p');
    error.className = 'recording-name-error';
    error.id = 'recording-name-modal-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;

    const actions = this.doc.createElement('div');
    actions.className = 'modal-actions';
    const saveBtn = this.doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-primary';
    saveBtn.dataset.recordingNameSave = '';
    const cancelBtn = this.doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.dataset.recordingNameCancel = '';
    actions.append(saveBtn, cancelBtn);
    card.append(icon, title, message, input, destinationRow, error, actions);
    overlay.append(card);
    this.doc.body.appendChild(overlay);

    saveBtn.addEventListener('click', () => void this.submit());
    cancelBtn.addEventListener('click', () => this.close('canceled'));
    input.addEventListener('input', () => this.showError());
    overlay.addEventListener('click', (event) => { if (event.target === overlay) this.close('canceled'); });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); this.close('canceled'); return; }
      if (event.key === 'Enter' && event.target === input) { event.preventDefault(); void this.submit(); return; }
      if (event.key === 'Tab') this.trapFocus(event, input, cancelBtn);
    });

    return { overlay, card, title, message, input, destinationRow, destinationSelect, error, saveBtn, cancelBtn };
  }

  /** Hidden unless the caller offers destinations, so a plain rename is unchanged. */
  private fillDestinations(parts: DialogParts, destinations?: RecordingNameDialogDestinations): void {
    parts.destinationRow.hidden = !destinations;
    parts.destinationSelect.replaceChildren();
    if (!destinations) return;

    const unfiled = this.doc.createElement('option');
    unfiled.value = '';
    unfiled.textContent = destinations.unfiledLabel;
    parts.destinationSelect.append(unfiled);
    for (const preset of destinations.presets) {
      const option = this.doc.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      parts.destinationSelect.append(option);
    }
    parts.destinationSelect.value = destinations.initialId ?? '';
  }

  private trapFocus(event: KeyboardEvent, first: HTMLElement, last: HTMLElement): void {
    const active = this.doc.activeElement;
    if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  }
}
