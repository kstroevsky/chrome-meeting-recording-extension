import { ConfirmDialog } from '../ConfirmDialog';

const OPTIONS = {
  title: 'Discard this recording?',
  message: 'Everything captured so far is permanently deleted.',
  confirmLabel: 'Discard recording',
  cancelLabel: 'Keep recording',
  tone: 'danger' as const,
};

const overlay = () => document.querySelector<HTMLElement>('.modal-overlay')!;
const confirmBtn = () => document.querySelector<HTMLButtonElement>('[data-confirm-accept]')!;
const cancelBtn = () => document.querySelector<HTMLButtonElement>('[data-confirm-cancel]')!;

const pressKey = (key: string, init: KeyboardEventInit = {}) =>
  overlay().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));

describe('ConfirmDialog', () => {
  let dialog: ConfirmDialog;

  beforeEach(() => {
    document.body.innerHTML = '';
    dialog = new ConfirmDialog();
  });

  afterEach(() => dialog.dispose());

  it('renders the prompt and resolves true only when the confirm button is pressed', async () => {
    const answer = dialog.ask(OPTIONS);

    expect(overlay().hidden).toBe(false);
    expect(document.querySelector('.modal-title')?.textContent).toBe(OPTIONS.title);
    expect(document.querySelector('.modal-message')?.textContent).toBe(OPTIONS.message);
    expect(confirmBtn().textContent).toBe(OPTIONS.confirmLabel);
    expect(confirmBtn().className).toContain('btn-danger');

    confirmBtn().click();

    await expect(answer).resolves.toBe(true);
    expect(overlay().hidden).toBe(true);
  });

  it('updates the message while a prompt remains open', () => {
    void dialog.ask(OPTIONS);
    dialog.updateMessage('You will lose 0:28 of recording.');

    expect(document.querySelector('.modal-message')?.textContent).toBe('You will lose 0:28 of recording.');
  });

  it('resolves false on cancel, Escape, and a backdrop click', async () => {
    const cancelled = dialog.ask(OPTIONS);
    cancelBtn().click();
    await expect(cancelled).resolves.toBe(false);

    const escaped = dialog.ask(OPTIONS);
    pressKey('Escape');
    await expect(escaped).resolves.toBe(false);

    const backdrop = dialog.ask(OPTIONS);
    overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await expect(backdrop).resolves.toBe(false);
  });

  it('keeps the dialog open when the click lands inside the card', async () => {
    const answer = dialog.ask(OPTIONS);

    document.querySelector('.modal-card')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();

    expect(overlay().hidden).toBe(false);
    expect(dialog.isOpen()).toBe(true);

    cancelBtn().click();
    await expect(answer).resolves.toBe(false);
  });

  it('focuses cancel first so a stray Enter cannot confirm a destructive action', () => {
    void dialog.ask(OPTIONS);
    expect(document.activeElement).toBe(cancelBtn());
  });

  it('traps Tab between the two actions and restores focus to the opener on close', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const answer = dialog.ask(OPTIONS);
    expect(document.activeElement).toBe(cancelBtn());

    pressKey('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(confirmBtn());

    pressKey('Tab');
    expect(document.activeElement).toBe(cancelBtn());

    cancelBtn().click();
    await expect(answer).resolves.toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('returns the in-flight answer instead of stacking a second modal', async () => {
    const first = dialog.ask(OPTIONS);
    const second = dialog.ask(OPTIONS);

    expect(document.querySelectorAll('.modal-overlay')).toHaveLength(1);

    confirmBtn().click();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it('reuses one overlay across asks and reports open state', async () => {
    const first = dialog.ask(OPTIONS);
    expect(dialog.isOpen()).toBe(true);
    cancelBtn().click();
    await expect(first).resolves.toBe(false);
    expect(dialog.isOpen()).toBe(false);

    const second = dialog.ask(OPTIONS);
    expect(document.querySelectorAll('.modal-overlay')).toHaveLength(1);
    confirmBtn().click();
    await expect(second).resolves.toBe(true);
  });

  it('cancels a pending answer when dismissed or disposed', async () => {
    const dismissed = dialog.ask(OPTIONS);
    dialog.dismiss();
    await expect(dismissed).resolves.toBe(false);
    expect(overlay().hidden).toBe(true);

    const disposed = dialog.ask(OPTIONS);
    dialog.dispose();
    await expect(disposed).resolves.toBe(false);
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  describe('destroyed-things preview (n3)', () => {
    it('lists what the action will destroy', async () => {
      const dialog = new ConfirmDialog();
      void dialog.ask({
        title: 'Discard this recording?',
        message: "You'll lose 22:40 of video, audio, the live transcript, and your notes. This can't be undone.",
        confirmLabel: 'Discard recording',
        cancelLabel: 'Keep recording',
        tone: 'danger',
        details: [
          { at: '2:34', text: 'Pricing objection' },
          { at: '5:12', text: 'Migration owner' },
        ],
      });

      const details = document.querySelector('.modal-details') as HTMLElement;
      expect(details.hidden).toBe(false);
      expect(Array.from(details.querySelectorAll('.modal-detail')).map((row) => row.textContent))
        .toEqual(['2:34Pricing objection', '5:12Migration owner']);
      expect(details.querySelector('.modal-detail-more')).toBeNull();
      dialog.dismiss();
    });

    it('caps the list so the dialog cannot outgrow the popup', async () => {
      const dialog = new ConfirmDialog();
      void dialog.ask({
        title: 'Discard this recording?',
        message: 'x',
        confirmLabel: 'Discard',
        cancelLabel: 'Keep',
        details: Array.from({ length: 7 }, (_, index) => ({ at: `0:0${index}`, text: `note ${index}` })),
      });

      const details = document.querySelector('.modal-details') as HTMLElement;
      expect(details.querySelectorAll('.modal-detail')).toHaveLength(3);
      expect(details.querySelector('.modal-detail-more')!.textContent).toBe('+4 more');
      dialog.dismiss();
    });

    it('stays out of the way when nothing named is at stake', async () => {
      const dialog = new ConfirmDialog();
      void dialog.ask({ title: 't', message: 'm', confirmLabel: 'y', cancelLabel: 'n' });

      expect((document.querySelector('.modal-details') as HTMLElement).hidden).toBe(true);
      dialog.dismiss();
    });
  });
});
