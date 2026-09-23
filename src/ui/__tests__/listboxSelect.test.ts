import { createListboxSelect, type ListboxSelect } from '../listboxSelect';

const OPTIONS = [
  { value: '', label: 'Google Meet Records' },
  { value: 'a', label: 'Work meetings' },
  { value: 'b', label: 'Interviews' },
];

describe('createListboxSelect', () => {
  let listbox: ListboxSelect;
  let onChange: jest.Mock;

  const trigger = () => listbox.root.querySelector<HTMLButtonElement>('.select-trigger')!;
  const list = () => listbox.root.querySelector<HTMLElement>('.select-options')!;
  const items = () => Array.from(list().querySelectorAll<HTMLButtonElement>('[role="option"]'));
  const key = (target: HTMLElement, k: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  beforeEach(() => {
    document.body.replaceChildren();
    onChange = jest.fn();
    listbox = createListboxSelect({ label: 'Destination', options: OPTIONS, onChange });
    document.body.append(listbox.root);
  });

  it('mirrors its options into a native select that holds the value', () => {
    expect(Array.from(listbox.select.options, (option) => option.value)).toEqual(['', 'a', 'b']);
    expect(listbox.select.value).toBe('');
    expect(listbox.getValue()).toBe('');
    expect(trigger().textContent).toBe('Google Meet Records');
  });

  it('keeps the native select out of the accessibility tree and the tab order', () => {
    expect(listbox.select.getAttribute('aria-hidden')).toBe('true');
    expect(listbox.select.tabIndex).toBe(-1);
    expect(list().getAttribute('role')).toBe('listbox');
    expect(trigger().getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger().getAttribute('aria-controls')).toBe(list().id);
  });

  it('opens on click, reports the chosen value once, and closes', () => {
    trigger().click();
    expect(list().hidden).toBe(false);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    items()[2].click();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('b');
    expect(listbox.getValue()).toBe('b');
    expect(list().hidden).toBe(true);
    expect(trigger().textContent).toBe('Interviews');
    expect(items()[2].getAttribute('aria-selected')).toBe('true');
    expect(items()[0].getAttribute('aria-selected')).toBe('false');
  });

  it('opens from the keyboard and focuses the selected option', () => {
    listbox.setValue('a');
    key(trigger(), 'ArrowDown');
    expect(list().hidden).toBe(false);
    expect(document.activeElement).toBe(items()[1]);

    key(list(), 'ArrowDown');
    expect(document.activeElement).toBe(items()[2]);
    key(list(), 'End');
    expect(document.activeElement).toBe(items()[2]);
    key(list(), 'Home');
    expect(document.activeElement).toBe(items()[0]);
  });

  it('closes on Escape without letting a hosting dialog see the key', () => {
    const outer = jest.fn();
    document.addEventListener('keydown', outer);
    trigger().click();
    key(items()[0], 'Escape');

    expect(list().hidden).toBe(true);
    expect(document.activeElement).toBe(trigger());
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outer);
  });

  it('closes when a click lands outside it', () => {
    trigger().click();
    document.body.click();
    expect(list().hidden).toBe(true);
  });

  it('falls back to the first option when the value matches none', () => {
    listbox.setOptions(OPTIONS, 'gone');
    expect(listbox.getValue()).toBe('');
    expect(trigger().textContent).toBe('Google Meet Records');
  });

  it('disables the trigger and the value holder together', () => {
    listbox.setDisabled(true);
    expect(trigger().disabled).toBe(true);
    expect(listbox.select.disabled).toBe(true);
    listbox.setDisabled(false);
    expect(trigger().disabled).toBe(false);
  });

  it('closes when it is disabled mid-choice, so no stale list is left open', () => {
    trigger().click();
    expect(list().hidden).toBe(false);
    listbox.setDisabled(true);
    expect(list().hidden).toBe(true);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('stops listening to the document once destroyed', () => {
    const other = createListboxSelect({ label: 'Other', options: OPTIONS, onChange: jest.fn() });
    document.body.append(other.root);
    other.root.querySelector<HTMLButtonElement>('.select-trigger')!.click();
    other.destroy();

    // A destroyed control must not act on later document clicks.
    expect(() => document.body.click()).not.toThrow();
    expect(other.root.isConnected).toBe(false);
  });
});

describe('createListboxSelect with search (7D)', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ value: `f${i}`, label: i < 3 ? `Weekly ${i}` : `Folder ${i}` }));
  const setup = (options = many) => {
    document.body.replaceChildren();
    const onChange = jest.fn();
    const listbox = createListboxSelect({
      label: 'Folder', options, onChange,
      search: { minOptions: 8, placeholder: 'Search folders', noun: 'FOLDERS' },
    });
    document.body.append(listbox.root);
    const trigger = listbox.root.querySelector<HTMLButtonElement>('.select-trigger')!;
    const search = () => listbox.root.querySelector<HTMLInputElement>('.select-search-input');
    const shown = () => Array.from(listbox.root.querySelectorAll<HTMLButtonElement>('[role="option"]')).filter((o) => !o.hidden);
    const count = () => listbox.root.querySelector<HTMLElement>('.select-count')!;
    const type = (text: string) => { search()!.value = text; search()!.dispatchEvent(new Event('input')); };
    const key = (k: string) => search()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    return { listbox, onChange, trigger, search, shown, count, type, key };
  };

  it('stays a plain list at eight options or fewer', () => {
    const { search, trigger } = setup(many.slice(0, 8));
    trigger.click();
    expect(search()).toBeNull();
  });

  it('opens into the search, filters as you type, and says how many it kept', () => {
    const { search, trigger, shown, count, type } = setup();
    trigger.click();
    expect(document.activeElement).toBe(search());
    expect(count().hidden).toBe(true);

    type('wee');
    expect(shown().map((o) => o.textContent)).toEqual(['Weekly 0', 'Weekly 1', 'Weekly 2']);
    expect(count().hidden).toBe(false);
    expect(count().textContent).toBe('3 OF 10 FOLDERS');
  });

  it('takes the first match on Enter', () => {
    const { listbox, onChange, trigger, type, key } = setup();
    trigger.click();
    type('folder 7');
    key('Enter');
    expect(onChange).toHaveBeenCalledWith('f7');
    expect(listbox.getValue()).toBe('f7');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('clears the search on the first Escape and closes on the second', () => {
    const { trigger, type, key, shown } = setup();
    trigger.click();
    type('wee');
    key('Escape');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(shown()).toHaveLength(10);
    key('Escape');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('walks only the options the search kept', () => {
    const { listbox, trigger, type, key } = setup();
    trigger.click();
    type('wee');
    key('ArrowDown');
    expect(document.activeElement?.textContent).toBe('Weekly 0');
    listbox.root.querySelector<HTMLElement>('.select-options')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(document.activeElement?.textContent).toBe('Weekly 2');
  });

  it('keeps the search across a rebuild of the options', () => {
    const { listbox, trigger, search } = setup();
    listbox.setOptions(many.slice(0, 9));
    trigger.click();
    expect(search()).not.toBeNull();
    listbox.setOptions(many.slice(0, 4));
    expect(listbox.root.querySelector('.select-search')).toBeNull();
  });
});

/**
 * The create row is an action, not a choice (7A). Everything here is about it
 * staying out of the way of choosing: never filtered, never selected, never
 * counted among the options.
 */
describe('createListboxSelect with a create row', () => {
  const build = (onCreate: (name: string) => Promise<{ value: string; label: string } | null>) => {
    document.body.replaceChildren();
    const onChange = jest.fn();
    const listbox = createListboxSelect({
      label: 'Destination',
      options: OPTIONS,
      onChange,
      create: { label: 'New folder…', placeholder: 'Folder name', onCreate },
    });
    document.body.append(listbox.root);
    return { listbox, onChange };
  };
  const row = () => document.querySelector<HTMLButtonElement>('.select-create')!;
  const field = () => document.querySelector<HTMLInputElement>('.select-create-input')!;
  const form = () => document.querySelector<HTMLElement>('.select-create-form')!;
  const enter = () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

  it('sits after the options without being one of them', () => {
    const { listbox } = build(async () => null);
    const options = Array.from(listbox.root.querySelectorAll('[role="option"]'));
    expect(options).toHaveLength(3);
    expect(row().getAttribute('role')).toBeNull();
    // Last in the list, under the folders it is offered beneath.
    expect(listbox.root.querySelector('.select-options')!.lastElementChild)
      .toBe(document.querySelector('.select-create-form'));
  });

  it('becomes a field, and adds what was typed as the selected option', async () => {
    const { listbox, onChange } = build(async (name) => ({ value: 'new-id', label: name }));
    row().click();
    expect(form().hidden).toBe(false);
    field().value = 'Standups';
    enter();
    await flush();

    expect(Array.from(listbox.select.options, (o) => o.value)).toEqual(['', 'a', 'b', 'new-id']);
    expect(listbox.getValue()).toBe('new-id');
    expect(onChange).toHaveBeenCalledWith('new-id');
  });

  it('keeps a refused name in the field to be edited rather than retyped', async () => {
    const { listbox } = build(async () => null);
    row().click();
    field().value = 'Work meetings';
    enter();
    await flush();

    expect(field().value).toBe('Work meetings');
    expect(field().getAttribute('aria-invalid')).toBe('true');
    expect(Array.from(listbox.select.options)).toHaveLength(3);
  });

  it('writes nothing on a blank name', async () => {
    const onCreate = jest.fn(async () => null);
    build(onCreate);
    row().click();
    field().value = '   ';
    enter();
    await flush();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('gives the row back on Escape, without closing the list', async () => {
    build(async () => null);
    row().click();
    field().value = 'Half typed';
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(row().hidden).toBe(false);
    expect(form().hidden).toBe(true);
    expect(field().value).toBe('');
  });

  it('is hidden entirely when the caller cannot create', () => {
    const { listbox } = build(async () => null);
    listbox.setCreateEnabled(false);
    expect(document.querySelector('.select-create')).toBeNull();
    listbox.setCreateEnabled(true);
    expect(document.querySelector('.select-create')).not.toBeNull();
  });

  it('survives a rebuild of the options, staying last', () => {
    const { listbox } = build(async () => null);
    listbox.setOptions([...OPTIONS, { value: 'c', label: 'Therapy' }], 'c');
    expect(document.querySelectorAll('.select-create')).toHaveLength(1);
    expect(listbox.root.querySelector('.select-options')!.lastElementChild)
      .toBe(document.querySelector('.select-create-form'));
  });
});

