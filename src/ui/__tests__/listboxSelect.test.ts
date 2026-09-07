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
