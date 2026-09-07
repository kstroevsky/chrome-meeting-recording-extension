import { RecordingNameDialog } from '../RecordingNameDialog';

const input = () => document.querySelector<HTMLInputElement>('.recording-name-input')!;
const save = () => document.querySelector<HTMLButtonElement>('[data-recording-name-save]')!;
const cancel = () => document.querySelector<HTMLButtonElement>('[data-recording-name-cancel]')!;
const overlay = () => document.querySelector<HTMLElement>('.recording-name-overlay')!;
const destinationRow = () => document.querySelector<HTMLElement>('.recording-name-destination')!;
const picker = () => document.querySelector<HTMLElement>('.recording-name-destination__select')!;
const destination = () => picker().querySelector<HTMLSelectElement>('.native-select')!;
const destinationTrigger = () => picker().querySelector<HTMLButtonElement>('.select-trigger')!;
const destinationOptions = () => Array.from(picker().querySelectorAll<HTMLButtonElement>('[role="option"]'));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RecordingNameDialog', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('prefills, focuses, and selects the current recording name', () => {
    const dialog = new RecordingNameDialog();
    void dialog.ask({
      title: 'Name recording', message: 'Choose a name', initialValue: 'Default recording', onSave: async () => {},
    });

    expect(input().value).toBe('Default recording');
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe('Default recording'.length);
  });

  it('validates blank and punctuation-only values without closing', async () => {
    const onSave = jest.fn();
    const dialog = new RecordingNameDialog();
    void dialog.ask({ title: 'Name recording', message: 'Choose a name', initialValue: '', onSave });

    save().click();
    expect(document.querySelector('.recording-name-error')?.textContent).toContain('blank');
    input().value = '---';
    save().click();
    expect(document.querySelector('.recording-name-error')?.textContent).toContain('letter or number');
    expect(onSave).not.toHaveBeenCalled();
    expect(overlay().hidden).toBe(false);
  });

  it('keeps the modal open with an inline error when saving fails', async () => {
    const dialog = new RecordingNameDialog();
    void dialog.ask({
      title: 'Name recording', message: 'Choose a name', initialValue: 'Default',
      onSave: async () => { throw new Error('Drive unavailable'); },
    });
    input().value = 'Quarterly Review';
    save().click();
    await flush();

    expect(document.querySelector('.recording-name-error')?.textContent).toBe('Drive unavailable');
    expect(overlay().hidden).toBe(false);
    expect(input().disabled).toBe(false);
  });

  it('disables controls while saving and resolves only after success', async () => {
    let resolveSave!: () => void;
    const onSave = jest.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const dialog = new RecordingNameDialog();
    const outcome = dialog.ask({ title: 'Name recording', message: 'Choose a name', initialValue: 'Default', onSave });
    input().value = 'Quarterly Review';
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(save().disabled).toBe(true);
    expect(cancel().disabled).toBe(true);
    expect(save().textContent).toBe('Saving…');
    resolveSave();
    await expect(outcome).resolves.toBe('saved');
    expect(onSave).toHaveBeenCalledWith('Quarterly Review', null);
    expect(overlay().hidden).toBe(true);
  });

  it('cancels on Escape and restores the previously focused element', async () => {
    const prior = document.createElement('button');
    document.body.appendChild(prior);
    prior.focus();
    const dialog = new RecordingNameDialog();
    const outcome = dialog.ask({ title: 'Name recording', message: 'Choose a name', initialValue: 'Default', onSave: async () => {} });
    overlay().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await expect(outcome).resolves.toBe('canceled');
    expect(document.activeElement).toBe(prior);
  });

  it('traps focus between the input and cancel button', () => {
    const dialog = new RecordingNameDialog();
    void dialog.ask({ title: 'Name recording', message: 'Choose a name', initialValue: 'Default', onSave: async () => {} });
    cancel().focus();
    cancel().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(input());
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(cancel());
  });

  describe('Drive destinations', () => {
    const presets = [{ id: 'dest-a', name: 'Work meetings' }, { id: 'dest-b', name: 'Interviews' }];

    it('offers the built-in folder first and reports the chosen destination', async () => {
      const onSave = jest.fn(async () => {});
      const dialog = new RecordingNameDialog();
      void dialog.ask({
        title: 'Name this recording', message: 'Choose a name', initialValue: 'Default', onSave,
        destinations: { presets, unfiledLabel: 'Google Meet Records', initialId: null },
      });

      expect(destinationRow().hidden).toBe(false);
      expect(destinationTrigger().textContent).toBe('Google Meet Records');
      expect(destinationOptions().map((option) => [option.dataset.value, option.textContent?.trim()])).toEqual([
        ['', 'Google Meet Records'],
        ['dest-a', 'Work meetings'],
        ['dest-b', 'Interviews'],
      ]);

      // Chosen the way a user does: open the listbox, pick an option.
      destinationTrigger().click();
      expect(destinationTrigger().getAttribute('aria-expanded')).toBe('true');
      destinationOptions()[2].click();
      expect(destinationTrigger().getAttribute('aria-expanded')).toBe('false');
      expect(destinationTrigger().textContent).toBe('Interviews');

      input().value = 'Candidate screen';
      save().click();
      await flush();

      expect(onSave).toHaveBeenCalledWith('Candidate screen', 'dest-b');
    });

    it('reports no destination when the built-in folder is kept', async () => {
      const onSave = jest.fn(async () => {});
      const dialog = new RecordingNameDialog();
      void dialog.ask({
        title: 'Name this recording', message: 'Choose a name', initialValue: 'Default', onSave,
        destinations: { presets, unfiledLabel: 'Google Meet Records', initialId: null },
      });
      input().value = 'Standup';
      save().click();
      await flush();

      expect(onSave).toHaveBeenCalledWith('Standup', null);
    });

    it('hides the field for a caller that only renames, and clears a previous list', async () => {
      const dialog = new RecordingNameDialog();
      void dialog.ask({
        title: 'Name this recording', message: 'Choose a name', initialValue: 'Default', onSave: async () => {},
        destinations: { presets, unfiledLabel: 'Google Meet Records', initialId: 'dest-a' },
      });
      expect(destination().value).toBe('dest-a');
      expect(destinationTrigger().textContent).toBe('Work meetings');
      dialog.dismiss();

      void dialog.ask({
        title: 'Rename', message: 'Choose a name', initialValue: 'Default', onSave: async () => {},
      });
      expect(destinationRow().hidden).toBe(true);
      expect(destinationOptions()).toHaveLength(0);
    });

    it('disables the picker while saving', async () => {
      let resolveSave!: () => void;
      const dialog = new RecordingNameDialog();
      void dialog.ask({
        title: 'Name this recording', message: 'Choose a name', initialValue: 'Default',
        destinations: { presets, unfiledLabel: 'Google Meet Records', initialId: null },
        onSave: () => new Promise<void>((resolve) => { resolveSave = resolve; }),
      });
      input().value = 'Retro';
      save().click();

      expect(destinationTrigger().disabled).toBe(true);
      resolveSave();
      await flush();
      expect(destinationTrigger().disabled).toBe(false);
    });
  });
});
