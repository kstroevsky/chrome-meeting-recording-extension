/**
 * @file ui/modalShell.ts
 *
 * The chrome shared by the popup's two promise-based prompts: the overlay and
 * card, the title/message/actions skeleton, focus capture and restore, Escape,
 * the backdrop click, and the Tab trap.
 *
 * `ConfirmDialog` and `RecordingNameDialog` had all of that twice, down to a
 * `trapFocus` that differed only in formatting. What they do *not* share is the
 * answer they resolve — a boolean versus `saved | canceled` — so each keeps its
 * own promise and its own body content. This owns the frame; they own the form.
 *
 * Deliberately not used by `PlayerView` (a full-screen player chrome, not a
 * prompt) or the recordings detail modal (rebuilt per redraw, no pending
 * answer). Neither would be simpler for being forced through here.
 */

export type ModalShellConfig = {
  doc?: Document;
  /** `alertdialog` for a destructive prompt; `dialog` otherwise. */
  role?: 'dialog' | 'alertdialog';
  /** Stem for the aria ids, so two dialogs on one page stay distinct. */
  idPrefix: string;
  /** Appended to the base `modal-overlay` / `modal-card` / `modal-icon`. */
  overlayClass?: string;
  cardClass?: string;
  iconClass?: string;
  /** Static markup owned by the caller; never user content. */
  iconSvg?: string;
  /** Escape, or a click on the scrim. Ignored while locked. */
  onDismiss: () => void;
};

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export class ModalShell {
  readonly overlay: HTMLElement;
  readonly card: HTMLElement;
  readonly title: HTMLElement;
  readonly message: HTMLElement;
  /** Where the owning dialog puts its own content, between message and actions. */
  readonly body: HTMLElement;
  readonly actions: HTMLElement;

  private readonly doc: Document;
  /** Focus owner at open time, restored on close. */
  private previousFocus: HTMLElement | null = null;
  /** Blocks dismissal while a submit is in flight. */
  private locked = false;

  constructor(private readonly config: ModalShellConfig) {
    const doc = (this.doc = config.doc ?? document);

    this.overlay = doc.createElement('div');
    this.overlay.className = `modal-overlay${config.overlayClass ? ` ${config.overlayClass}` : ''}`;
    this.overlay.hidden = true;

    this.card = doc.createElement('div');
    this.card.className = `modal-card${config.cardClass ? ` ${config.cardClass}` : ''}`;
    this.card.setAttribute('role', config.role ?? 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-labelledby', `${config.idPrefix}-title`);
    this.card.setAttribute('aria-describedby', `${config.idPrefix}-message`);

    this.title = doc.createElement('h2');
    this.title.className = 'modal-title';
    this.title.id = `${config.idPrefix}-title`;

    this.message = doc.createElement('p');
    this.message.className = 'modal-message';
    this.message.id = `${config.idPrefix}-message`;

    this.body = doc.createElement('div');
    this.body.className = 'modal-body';

    this.actions = doc.createElement('div');
    this.actions.className = 'modal-actions';

    if (config.iconSvg) {
      const icon = doc.createElement('span');
      icon.className = `modal-icon${config.iconClass ? ` ${config.iconClass}` : ''}`;
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = config.iconSvg;
      this.card.append(icon);
    }
    this.card.append(this.title, this.message, this.body, this.actions);
    this.overlay.append(this.card);
    doc.body.appendChild(this.overlay);

    // A click on the scrim (never on the card) reads as "get me out".
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.dismiss();
    });
    this.overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); this.dismiss(); return; }
      if (event.key === 'Tab') this.trapFocus(event);
    });
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  /** Shows the dialog, remembering who had focus so close can hand it back. */
  open(focus?: HTMLElement | null): void {
    const active = this.doc.activeElement;
    this.previousFocus = active instanceof HTMLElement ? active : null;
    this.overlay.hidden = false;
    focus?.focus();
  }

  close(): void {
    this.overlay.hidden = true;
    this.previousFocus?.focus();
    this.previousFocus = null;
  }

  /** While locked, Escape and the backdrop do nothing — a save is in flight. */
  setLocked(locked: boolean): void {
    this.locked = locked;
  }

  destroy(): void {
    this.overlay.remove();
  }

  private dismiss(): void {
    if (this.locked) return;
    this.config.onDismiss();
  }

  /**
   * Cycles Tab within the card. The focusable set is read at keypress rather
   * than fixed at build time, because a dialog's controls come and go — the
   * name prompt's destination picker is only there when destinations exist.
   */
  private trapFocus(event: KeyboardEvent): void {
    const items = Array.from(this.card.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((item) => !(item as HTMLButtonElement).disabled && !item.closest('[hidden]'));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = this.doc.activeElement;
    if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  }
}
