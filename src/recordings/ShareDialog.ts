import type { PublishRecordingOptions } from '../sharing/PublishedManifestBuilder';

export type CreatedShareLink = { shareId: string; shareUrl: string };
export type ShareProgressReporter = (message: string) => void;

export type ShareDialogActions = {
  publish: (options: PublishRecordingOptions, report: ShareProgressReporter) => Promise<CreatedShareLink>;
  revoke?: (shareId: string) => Promise<void>;
};

/** One self-contained owner prompt: privacy choices, publish progress, then link actions. */
export class ShareDialog {
  private readonly overlay = document.createElement('div');
  private readonly card = document.createElement('section');
  private readonly status = document.createElement('p');
  private readonly options = document.createElement('div');
  private readonly actions = document.createElement('div');
  private readonly create = document.createElement('button');
  private readonly transcriptInput: HTMLInputElement;
  private readonly topicsInput: HTMLInputElement;
  private locked = false;
  private created: CreatedShareLink | null = null;

  constructor(
    recordingNames: readonly string[],
    private readonly callbacks: ShareDialogActions,
  ) {
    this.overlay.className = 'share-dialog-overlay';
    this.card.className = 'share-dialog';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-labelledby', 'share-dialog-title');

    const heading = document.createElement('div');
    heading.className = 'share-dialog__heading';
    const title = document.createElement('h2');
    title.id = 'share-dialog-title';
    title.textContent = recordingNames.length === 1 ? 'Share recording' : `Share ${recordingNames.length} recordings`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'share-dialog__close';
    close.setAttribute('aria-label', 'Close sharing dialog');
    close.textContent = '×';
    close.addEventListener('click', () => this.dismiss());
    heading.append(title, close);

    const summary = document.createElement('p');
    summary.className = 'share-dialog__summary';
    summary.textContent = recordingNames.length <= 2
      ? recordingNames.join(' · ')
      : `${recordingNames.slice(0, 2).join(' · ')} · +${recordingNames.length - 2} more`;

    const description = document.createElement('p');
    description.className = 'share-dialog__description';
    description.textContent = 'Choose what becomes part of this immutable shared snapshot. Private Drive and local storage identifiers are never published.';

    const transcript = this.option('Transcript', 'Include captured caption text', true);
    const topics = this.option('Topics', 'Include topic labels and seek points', true);
    this.transcriptInput = transcript.input;
    this.topicsInput = topics.input;
    const notes = this.option('Notes', 'Include your saved recording notes', false);
    const selfVideo = this.option('Self camera', 'Include the separate camera track', false);
    transcript.input.addEventListener('change', () => {
      topics.input.disabled = !transcript.input.checked;
      topics.row.classList.toggle('share-dialog__option--disabled', topics.input.disabled);
    });
    this.options.className = 'share-dialog__options';
    this.options.append(transcript.row, topics.row, notes.row, selfVideo.row);

    this.status.className = 'share-dialog__status';
    this.status.hidden = true;
    this.status.setAttribute('role', 'status');

    this.actions.className = 'share-dialog__actions';
    const cancel = this.button('Cancel', 'share-dialog__button share-dialog__button--secondary', () => this.dismiss());
    this.create.type = 'button';
    this.create.className = 'share-dialog__button share-dialog__button--primary';
    this.create.textContent = 'Create link';
    this.create.addEventListener('click', () => void this.publish({
      includeTranscript: transcript.input.checked,
      includeTopics: transcript.input.checked && topics.input.checked,
      includeNotations: notes.input.checked,
      includeSelfVideo: selfVideo.input.checked,
    }));
    this.actions.append(cancel, this.create);

    this.card.append(heading, summary, description, this.options, this.status, this.actions);
    this.overlay.append(this.card);
    this.overlay.addEventListener('click', (event) => { if (event.target === this.overlay) this.dismiss(); });
    this.overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); this.dismiss(); }
    });
  }

  open(): void {
    document.body.append(this.overlay);
    this.create.focus();
  }

  private option(title: string, detail: string, checked: boolean) {
    const row = document.createElement('label');
    row.className = 'share-dialog__option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = title;
    const description = document.createElement('small');
    description.textContent = detail;
    text.append(name, description);
    row.append(input, text);
    return { row, input };
  }

  private async publish(options: PublishRecordingOptions): Promise<void> {
    if (this.locked) return;
    this.setLocked(true);
    this.setStatus('Preparing recordings…');
    try {
      this.created = await this.callbacks.publish(options, (message) => this.setStatus(message));
      this.renderCreated();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), true);
      this.setLocked(false);
    }
  }

  private renderCreated(): void {
    if (!this.created) return;
    this.setLocked(false);
    this.options.hidden = true;
    this.status.hidden = true;
    this.actions.replaceChildren();

    const result = document.createElement('div');
    result.className = 'share-dialog__result';
    const label = document.createElement('span');
    label.textContent = 'Share link';
    const input = document.createElement('input');
    input.className = 'share-dialog__link';
    input.type = 'text';
    input.readOnly = true;
    input.value = this.created.shareUrl;
    input.addEventListener('focus', () => input.select());
    result.append(label, input);
    this.card.insertBefore(result, this.actions);

    const copy = this.button('Copy', 'share-dialog__button share-dialog__button--primary', () => void this.copyLink());
    const open = this.button('Open', 'share-dialog__button share-dialog__button--secondary', () => {
      if (this.created) window.open(this.created.shareUrl, '_blank', 'noopener');
    });
    const close = this.button('Done', 'share-dialog__button share-dialog__button--secondary', () => this.dismiss());
    this.actions.append(copy, open);
    if (this.callbacks.revoke) {
      this.actions.append(this.button('Revoke', 'share-dialog__button share-dialog__button--danger', () => void this.revoke()));
    }
    this.actions.append(close);
    input.focus();
    input.select();
  }

  private async copyLink(): Promise<void> {
    if (!this.created) return;
    try {
      await navigator.clipboard.writeText(this.created.shareUrl);
      this.setStatus('Link copied.');
    } catch {
      this.setStatus('Could not copy automatically. Select the link and copy it.', true);
    }
  }

  private async revoke(): Promise<void> {
    if (!this.created || !this.callbacks.revoke || this.locked) return;
    this.setLocked(true);
    this.setStatus('Revoking link…');
    try {
      await this.callbacks.revoke(this.created.shareId);
      this.setStatus('Link revoked. New playback requests will be denied.');
      this.setLocked(false);
      for (const button of Array.from(this.actions.querySelectorAll<HTMLButtonElement>('button'))) {
        if (button.textContent !== 'Done') button.disabled = true;
      }
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), true);
      this.setLocked(false);
    }
  }

  private button(label: string, className: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', action);
    return button;
  }

  private setStatus(message: string, error = false): void {
    this.status.hidden = false;
    this.status.textContent = message;
    this.status.classList.toggle('share-dialog__status--error', error);
  }

  private setLocked(locked: boolean): void {
    this.locked = locked;
    for (const control of Array.from(this.card.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'))) {
      control.disabled = locked;
    }
    if (!locked && !this.transcriptInput.checked) this.topicsInput.disabled = true;
  }

  private dismiss(): void {
    if (!this.locked) this.overlay.remove();
  }
}
