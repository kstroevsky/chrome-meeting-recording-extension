/**
 * @file ui/listboxSelect.ts
 *
 * The extension's select control, built for surfaces whose options are only
 * known at runtime.
 *
 * Every dropdown in this extension is the same shape: a native `<select>` kept
 * as the data source, a `.select-trigger` button, and a `.select-options`
 * listbox of `role="option"` buttons.
 *
 * Two entry points, because markup comes from two places:
 *
 * - `bindListbox` wires the behaviour onto elements that already exist. The
 *   popup's "Save to" is authored in `popup.html`, and markup in HTML is the
 *   clearer expression when the options are fixed at build time.
 * - `createListboxSelect` builds the markup first, then binds. Drive
 *   destinations are user-authored, so there is nothing to write in HTML.
 *
 * Either way the keyboard handling, the outside-click close and the
 * trigger/native-select synchronisation are this file's, once.
 *
 * The native select stays for the same reason the static surfaces keep theirs:
 * it holds the value, it is what a test or a form reads, and it keeps the
 * control meaningful if the listbox script ever fails to run.
 *
 * Skins live with each page's palette (popup/config.css, recordings.css); only
 * the behaviour and the class contract are shared.
 */

export type ListboxOption = { value: string; label: string };

export type ListboxSelectConfig = {
  /** Accessible name for the trigger and the listbox alike. */
  label: string;
  options: ListboxOption[];
  /** Initial value; falls back to the first option when it matches none. */
  value?: string;
  /** Extra class on the wrapper, so a page can scope its own skin. */
  className?: string;
  onChange: (value: string) => void;
  doc?: Document;
};

/** Elements `bindListbox` adopts; they must already be in the document. */
export type ListboxElements = {
  select: HTMLSelectElement;
  trigger: HTMLButtonElement;
  list: HTMLElement;
  doc?: Document;
};

export type BindListboxConfig = {
  /** Called after the value changes, in addition to the select's own event. */
  onChange?: (value: string) => void;
  /** Runs on every sync, for a trigger that shows more than a label. */
  onSync?: (elements: { select: HTMLSelectElement; trigger: HTMLButtonElement; list: HTMLElement }) => void;
};

export type ListboxBinding = {
  /** The value holder, and what a test reads. */
  readonly select: HTMLSelectElement;
  setOptions(options: ListboxOption[], value?: string): void;
  getValue(): string;
  setValue(value: string): void;
  setDisabled(disabled: boolean): void;
  close(): void;
  /** Drops the document-level listeners; call when the host is torn down. */
  destroy(): void;
};

/** A binding that also owns the markup, so `destroy` takes the DOM with it. */
export type ListboxSelect = ListboxBinding & { readonly root: HTMLElement };

const CHECK_SVG =
  '<svg class="select-check" width="12" height="10" viewBox="0 0 14 11" fill="none" aria-hidden="true">' +
  '<path d="M1.5 6l3.5 3.5L12.5 1.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let sequence = 0;

export function createListboxSelect(config: ListboxSelectConfig): ListboxSelect {
  const doc = config.doc ?? document;
  const id = `listbox-${++sequence}`;

  const root = doc.createElement('div');
  root.className = config.className ? `listbox ${config.className}` : 'listbox';

  // Hidden from assistive tech: the listbox below is the accessible control,
  // and exposing both would announce every choice twice.
  const select = doc.createElement('select');
  select.className = 'native-select';
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  const trigger = doc.createElement('button');
  trigger.type = 'button';
  trigger.className = 'select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', `${id}-options`);
  trigger.setAttribute('aria-label', config.label);
  const triggerLabel = doc.createElement('span');
  triggerLabel.dataset.selectLabel = '';
  trigger.append(triggerLabel);

  const list = doc.createElement('div');
  list.id = `${id}-options`;
  list.className = 'select-options';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', config.label);
  list.hidden = true;

  root.append(select, trigger, list);

  const binding = bindListbox({ select, trigger, list, doc }, { onChange: config.onChange });
  binding.setOptions(config.options, config.value);

  return {
    ...binding,
    root,
    destroy: () => { binding.destroy(); root.remove(); },
  };
}

/**
 * Wires the behaviour onto an existing trigger/listbox pair. The native select
 * stays the value holder, and its `change` event still fires, so code that
 * listens to the select keeps working whether a person used the listbox or the
 * value was set programmatically.
 */
export function bindListbox(elements: ListboxElements, config: BindListboxConfig = {}): ListboxBinding {
  const { select, trigger, list } = elements;
  const doc = elements.doc ?? document;

  const abort = new AbortController();
  const signal = abort.signal;

  const items = () => Array.from(list.querySelectorAll<HTMLButtonElement>('[role="option"]'));

  const sync = () => {
    const selected = select.selectedOptions[0];
    const label = trigger.querySelector<HTMLElement>('[data-select-label]');
    const text = selected?.textContent ?? '';
    if (label) label.textContent = text;
    else trigger.textContent = text;
    trigger.title = text;
    for (const item of items()) {
      item.setAttribute('aria-selected', String(item.dataset.value === select.value));
    }
    config.onSync?.({ select, trigger, list });
  };

  const close = () => {
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  };

  const focusOption = (index: number) => {
    const all = items();
    if (!all.length) return;
    all[Math.max(0, Math.min(index, all.length - 1))]?.focus();
  };

  const open = (initialOffset = 0) => {
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const selected = items().findIndex((item) => item.getAttribute('aria-selected') === 'true');
    focusOption(Math.max(0, selected) + initialOffset);
  };

  const choose = (value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    close();
    trigger.focus();
    config.onChange?.(value);
  };

  trigger.addEventListener('click', () => { if (list.hidden) open(); else close(); }, { signal });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open(event.key === 'ArrowDown' ? 0 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      open(event.key === 'Home' ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER);
    }
  }, { signal });

  list.addEventListener('click', (event) => {
    const option = (event.target as Element | null)?.closest<HTMLButtonElement>('[role="option"]');
    if (option?.dataset.value !== undefined && !option.disabled) choose(option.dataset.value);
  }, { signal });
  list.addEventListener('keydown', (event) => {
    const all = items();
    const index = all.indexOf(doc.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusOption(index + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusOption(event.key === 'Home' ? 0 : all.length - 1);
    } else if (event.key === 'Escape') {
      // Stops here so a dialog hosting this control is not closed by the same key.
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus();
    }
  }, { signal });

  select.addEventListener('change', () => sync(), { signal });
  doc.addEventListener('click', (event) => {
    const target = event.target as Node;
    if (!list.hidden && !list.contains(target) && !trigger.contains(target)) close();
  }, { signal });

  const setOptions = (options: ListboxOption[], value?: string) => {
    select.replaceChildren();
    list.replaceChildren();
    for (const option of options) {
      const native = doc.createElement('option');
      native.value = option.value;
      native.textContent = option.label;
      select.append(native);

      const item = doc.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.dataset.value = option.value;
      item.setAttribute('aria-selected', 'false');
      item.append(doc.createTextNode(option.label));
      item.insertAdjacentHTML('beforeend', CHECK_SVG);
      list.append(item);
    }
    select.value = value ?? select.value;
    // An unknown value would leave the native select blank; the first option is
    // the honest fallback, and callers pass the unfiled entry first.
    if (select.selectedIndex < 0) select.selectedIndex = 0;
    sync();
  };

  sync();

  return {
    select,
    setOptions,
    getValue: () => select.value,
    setValue: (value: string) => { select.value = value; sync(); },
    setDisabled: (disabled: boolean) => {
      select.disabled = disabled;
      trigger.disabled = disabled;
      if (disabled) close();
    },
    close,
    destroy: () => abort.abort(),
  };
}
