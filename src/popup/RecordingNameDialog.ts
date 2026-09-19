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
  /** Receives the destination the user picked, or null for the built-in folder. */
  onSave: (name: string, destinationId: string | null) => Promise<void>;
};

export type RecordingNameDialogOutcome = 'saved' | 'canceled';

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
    this.showError();
    this.setBusy(false);

    let settle!: (outcome: RecordingNameDialogOutcome) => void;
    const promise = new Promise<RecordingNameDialogOutcome>((resolve) => { settle = resolve; });
    this.pending = { promise, settle, options };
    parts.shell.open(parts.input);
    parts.input.select();
    return promise;
  }

  dismiss = (): void => this.close('canceled');

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
    if (!pending || !parts || this.busy) return;
    const name = parts.input.value.trim();
    const destinationId = pending.options.destinations ? parts.destinationSelect.getValue() || null : null;
    if (!name) { this.showError(BLANK_NAME); return; }
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
    if (this.parts) {
      this.parts.destinationSelect.close();
      this.parts.shell.close();
    }
    pending.settle(outcome);
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (!this.parts) return;
    // A save in flight must not be dismissable by Escape or the backdrop.
    this.parts.shell.setLocked(busy);
    this.parts.input.disabled = busy;
    this.parts.destinationSelect.setDisabled(busy);
    this.parts.saveBtn.disabled = busy;
    this.parts.cancelBtn.disabled = busy;
    this.parts.saveBtn.textContent = busy ? 'Saving…' : (this.pending?.options.saveLabel ?? this.parts.saveBtn.textContent);
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
    if (!this.parts || this.busy) return;
    const blank = !this.parts.input.value.trim();
    this.parts.saveBtn.disabled = blank;
    this.showError(blank ? BLANK_NAME : '');
  }

  private build(): DialogParts {
    const shell = new ModalShell({
      doc: this.doc,
      idPrefix: 'recording-name-modal',
      overlayClass: 'recording-name-overlay',
      cardClass: 'recording-name-card',
      iconClass: 'recording-name-icon',
      iconSvg: SAVE_ICON,
      onDismiss: () => this.close('canceled'),
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
      options: [],
      onChange: () => {},
      doc: this.doc,
    });
    destinationRow.append(destinationLabel, destinationSelect.root);

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
    shell.body.append(label('NAME'), input, shell.message, error, destinationRow);

    saveBtn.addEventListener('click', () => void this.submit());
    cancelBtn.addEventListener('click', () => this.close('canceled'));
    input.addEventListener('input', () => this.syncBlank());
    // Escape, the backdrop and the Tab trap belong to the shell; Enter-to-save
    // is this dialog's own, and must run before the shell sees the key.
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void this.submit(); }
    });

    return { shell, summary, input, destinationRow, destinationSelect, error, saveBtn, cancelBtn };
  }

  /** Hidden unless the caller offers destinations, so a plain rename is unchanged. */
  private fillDestinations(parts: DialogParts, destinations?: RecordingNameDialogDestinations): void {
    parts.destinationRow.hidden = !destinations;
    if (!destinations) {
      parts.destinationSelect.setOptions([]);
      return;
    }
    parts.destinationSelect.setOptions([
      { value: '', label: destinations.unfiledLabel },
      ...destinations.presets.map((preset) => ({ value: preset.id, label: preset.name })),
    ], destinations.initialId ?? '');
  }
}
