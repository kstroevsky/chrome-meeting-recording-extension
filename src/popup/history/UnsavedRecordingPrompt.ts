/**
 * @file popup/history/UnsavedRecordingPrompt.ts
 *
 * Offers back a recording a crash left behind (design 8D).
 *
 * The bytes are already safe — capture writes straight to OPFS, and the scan
 * that finds them touches nothing. What this adds is the choice: the recovery
 * that used to happen silently, on the next launch, decided for the user and
 * always downloaded. A recording is theirs, so saving it under a name they
 * choose, or throwing it away, is theirs to say.
 *
 * Asked once per popup open, newest first: the one they just lost is the one
 * they mean. Declining to answer leaves it exactly where it is — the unattended
 * recovery takes over only after a week (ORPHAN_DECISION_WINDOW_MS).
 */

import { formatBytes } from '../../shared/format';
import { ModalShell } from '../../ui/modalShell';
import { slugifyRecordingTitle } from '../../shared/recording';
import type { UnsavedRecording } from '../../offscreen/storage/recoverOrphanRecordings';

export type UnsavedRecordingActions = {
  /** What a crash left behind; empty in the ordinary case. */
  list: () => Promise<UnsavedRecording[]>;
  /** Saves it under a title, or throws it away. */
  resolve: (key: string, action: 'save' | 'discard', name?: string) => Promise<void>;
  notify: (message: string) => void;
  /** True while the popup is a static preview or torn down — never prompt then. */
  suspended: () => boolean;
};

/** The warning mark (8D): a plain exclamation, drawn in the caution gold. */
const WARN_ICON = '<svg viewBox="0 0 22 22" fill="none"><path d="M11 6.4v5.2M11 15.1v.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="11" cy="11" r="7.4" stroke="currentColor" stroke-width="1.5"/></svg>';

const BLANK_NAME = 'Give the recording a name to save it.';

export class UnsavedRecordingPrompt {
  private shell: ModalShell | null = null;
  private parts: {
    summary: HTMLElement;
    input: HTMLInputElement;
    error: HTMLElement;
    save: HTMLButtonElement;
    discard: HTMLButtonElement;
  } | null = null;
  private open = false;
  private busy = false;
  /** Answered or declined this session; never re-offered until the popup reopens. */
  private readonly seen = new Set<string>();

  constructor(private readonly actions: UnsavedRecordingActions, private readonly doc: Document = document) {}

  /** Looks once, and offers the newest thing found. Silent when there is nothing. */
  async offerNext(): Promise<void> {
    if (this.open || this.actions.suspended()) return;
    let found: UnsavedRecording[] = [];
    try {
      found = await this.actions.list();
    } catch {
      // A recovery we cannot ask about is not an error worth showing: the bytes
      // are still on disk, and the next open asks again.
      return;
    }
    const next = found.find((recording) => !this.seen.has(recording.key));
    if (!next || this.actions.suspended()) return;
    this.seen.add(next.key);
    this.show(next);
  }

  dispose(): void {
    this.shell?.destroy();
    this.shell = null;
    this.parts = null;
    this.open = false;
  }

  private show(recording: UnsavedRecording): void {
    const { shell, parts } = this.build();
    shell.title.textContent = 'Unsaved recording found';
    shell.message.textContent = 'The tab closed before this one was saved. It was kept on this device.';
    // Size and the reason it ended; a capture that never sealed has no duration
    // to show, so the line says what is actually known.
    parts.summary.textContent = `${formatBytes(recording.sizeBytes).toUpperCase()} · THE MEETING ENDED`;
    parts.input.value = defaultTitle(recording.filename);
    this.setBusy(false);
    this.syncBlank();
    this.open = true;
    shell.open(parts.input);
    parts.input.select();

    parts.save.onclick = () => void this.resolve(recording, 'save');
    parts.discard.onclick = () => void this.resolve(recording, 'discard');
  }

  private async resolve(recording: UnsavedRecording, action: 'save' | 'discard'): Promise<void> {
    const parts = this.parts;
    if (!parts || this.busy) return;
    const name = parts.input.value.trim();
    if (action === 'save') {
      if (!name) { this.showError(BLANK_NAME); return; }
      if (!slugifyRecordingTitle(name)) { this.showError('Use at least one letter or number'); return; }
    }
    this.showError();
    this.setBusy(true);
    try {
      await this.actions.resolve(recording.key, action, action === 'save' ? name : undefined);
      this.close();
      this.actions.notify(action === 'save' ? 'Saving the recovered recording' : 'Recording discarded');
    } catch (error) {
      this.setBusy(false);
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  private close(): void {
    this.open = false;
    this.setBusy(false);
    this.shell?.close();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    const parts = this.parts;
    if (!parts) return;
    // A save in flight must not be dismissable: the bytes are mid-move.
    this.shell?.setLocked(busy);
    parts.input.disabled = busy;
    parts.save.disabled = busy;
    parts.discard.disabled = busy;
    parts.save.textContent = busy ? 'Saving…' : 'Save it now';
  }

  private showError(message = ''): void {
    const parts = this.parts;
    if (!parts) return;
    parts.error.textContent = message;
    parts.error.hidden = !message;
    parts.input.setAttribute('aria-invalid', String(Boolean(message)));
  }

  private syncBlank(): void {
    const parts = this.parts;
    if (!parts || this.busy) return;
    parts.save.disabled = !parts.input.value.trim();
  }

  private build() {
    if (this.shell && this.parts) return { shell: this.shell, parts: this.parts };
    const shell = new ModalShell({
      doc: this.doc,
      idPrefix: 'unsaved-recording-modal',
      overlayClass: 'recording-name-overlay unsaved-recording-overlay',
      cardClass: 'recording-name-card',
      iconClass: 'recording-name-icon unsaved-recording-icon',
      iconSvg: WARN_ICON,
      // Escape and the backdrop leave it alone rather than discarding it: doing
      // nothing must never be the same gesture as throwing a recording away.
      onDismiss: () => this.close(),
    });
    const summary = this.doc.createElement('p');
    summary.className = 'recording-name-summary';
    shell.title.after(summary);
    shell.message.classList.add('recording-name-hint');

    const label = this.doc.createElement('div');
    label.className = 'recording-name-label';
    label.textContent = 'NAME';
    const input = this.doc.createElement('input');
    input.className = 'recording-name-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Recording name');
    const error = this.doc.createElement('p');
    error.className = 'recording-name-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;

    const save = this.doc.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-ink';
    save.dataset.unsavedSave = '';
    save.textContent = 'Save it now';
    const discard = this.doc.createElement('button');
    discard.type = 'button';
    discard.className = 'unsaved-recording-discard';
    discard.dataset.unsavedDiscard = '';
    discard.textContent = 'Discard it';

    shell.body.append(shell.message, label, input, error);
    shell.actions.append(save, discard);
    input.addEventListener('input', () => { this.showError(); this.syncBlank(); });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      save.click();
    });

    this.shell = shell;
    this.parts = { summary, input, error, save, discard };
    return { shell, parts: this.parts };
  }
}

/** The generated name, made readable, so the field opens with something usable. */
function defaultTitle(filename: string): string {
  const match = filename.match(/^google-meet-(.+)-(\d{8})T(\d{4})-/);
  if (!match) return 'Recovered recording';
  const [, slug, date, time] = match;
  const readable = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `${readable} — ${date.slice(4, 6)}/${date.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2)}`;
}
