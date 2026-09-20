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

/**
 * A search row at the top of a long list (design 7D: "the picker gains search
 * past ~8 folders"), with a count of what it kept once something is typed.
 */
export type ListboxSearch = {
  /** Offered only when there are more options than this. */
  minOptions: number;
  placeholder: string;
  /** Plural noun for the count line: `4 OF 26 FOLDERS`. */
  noun: string;
};

/**
 * An opt-in last row that makes a new option instead of choosing one (design
 * 7A). Deliberately not a `role="option"`: it is an action, not a choice, so
 * the search row never filters it away and choosing by keyboard never lands on
 * it by accident.
 */
export type ListboxCreate = {
  /** The row's own label, e.g. `New folder…`. */
  label: string;
  placeholder: string;
  /** Returns the option to add and select, or null when the name was refused. */
  onCreate: (name: string) => Promise<ListboxOption | null>;
};

export type ListboxSelectConfig = {
  /** Accessible name for the trigger and the listbox alike. */
  label: string;
  options: ListboxOption[];
  /** Initial value; falls back to the first option when it matches none. */
  value?: string;
  /** Extra class on the wrapper, so a page can scope its own skin. */
  className?: string;
  /** Opt-in search row for a long list; see {@link ListboxSearch}. */
  search?: ListboxSearch;
  /** Opt-in row that creates a new option; see {@link ListboxCreate}. */
  create?: ListboxCreate;
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
  /** Runs as the list opens; an element it returns takes focus instead of the selected option. */
  onOpen?: () => HTMLElement | null;
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

const SEARCH_SVG =
  '<svg class="select-search-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.4"/><path d="M10.2 10.2L13.5 13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

const PLUS_SVG =
  '<svg class="select-create-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M8 3.4v9.2M3.4 8h9.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

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

  const search = config.search ? createSearch(doc, list, root, config.search) : null;
  const binding = bindListbox({ select, trigger, list, doc }, {
    onChange: config.onChange,
    ...(search ? { onOpen: () => search.open() } : {}),
  });
  const setOptions = (options: ListboxOption[], value?: string) => {
    binding.setOptions(options, value);
    search?.decorate();
    // Last, after the search row's count, so the action stays below the choices.
    creator?.mount();
  };
  const creator = config.create
    ? createCreator(doc, list, config.create, (option) => {
      const existing = Array.from(select.options).map((o) => ({ value: o.value, label: o.text }));
      setOptions([...existing, option], option.value);
      config.onChange(option.value);
      binding.close();
    })
    : null;
  setOptions(config.options, config.value);

  return {
    ...binding,
    setOptions,
    root,
    close: () => { creator?.reset(); binding.close(); },
    destroy: () => { binding.destroy(); root.remove(); },
  };
}

/**
 * The create row, and the field it becomes. Kept outside the options so a
 * `setOptions` rebuild can put it back at the bottom of the new list.
 */
function createCreator(
  doc: Document,
  list: HTMLElement,
  config: ListboxCreate,
  onCreated: (option: ListboxOption) => void,
) {
  const row = doc.createElement('button');
  row.type = 'button';
  row.className = 'select-create';
  row.dataset.selectCreate = '';
  row.insertAdjacentHTML('afterbegin', PLUS_SVG);
  const rowLabel = doc.createElement('span');
  rowLabel.textContent = config.label;
  row.append(rowLabel);

  const form = doc.createElement('div');
  form.className = 'select-create-form';
  form.hidden = true;
  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'select-create-input';
  input.autocomplete = 'off';
  input.placeholder = config.placeholder;
  input.setAttribute('aria-label', config.label);
  form.append(input);

  let busy = false;
  const reset = () => {
    busy = false;
    input.value = '';
    input.removeAttribute('aria-invalid');
    form.hidden = true;
    row.hidden = false;
  };
  const submit = async () => {
    const name = input.value.trim();
    if (!name || busy) return;
    busy = true;
    input.setAttribute('aria-busy', 'true');
    try {
      const option = await config.onCreate(name);
      if (!option) {
        // Refused — a duplicate, or one folder too many. The name stays put so
        // it can be edited rather than retyped.
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      reset();
      onCreated(option);
    } finally {
      busy = false;
      input.removeAttribute('aria-busy');
    }
  };

  row.addEventListener('click', (event) => {
    event.stopPropagation();
    row.hidden = true;
    form.hidden = false;
    input.focus();
  });
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void submit(); }
    // Escape gives the row back before the list itself may close.
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); reset(); }
  });

  return {
    mount: () => { list.append(row, form); },
    reset,
  };
}

/**
 * The search row and its count, kept outside the options so a `setOptions`
 * rebuild can put them back around the new list.
 */
function createSearch(doc: Document, list: HTMLElement, root: HTMLElement, config: ListboxSearch) {
  const row = doc.createElement('div');
  row.className = 'select-search';
  row.insertAdjacentHTML('afterbegin', SEARCH_SVG);
  const input = doc.createElement('input');
  input.type = 'text';
  input.className = 'select-search-input';
  input.autocomplete = 'off';
  input.placeholder = config.placeholder;
  input.setAttribute('aria-label', config.placeholder);
  row.append(input);
  const count = doc.createElement('div');
  count.className = 'select-count';
  count.setAttribute('aria-live', 'polite');

  const options = () => Array.from(list.querySelectorAll<HTMLButtonElement>('[role="option"]'));
  const active = () => options().length > config.minOptions;
  const filter = () => {
    const query = input.value.trim().toLowerCase();
    const all = options();
    let shown = 0;
    for (const option of all) {
      option.hidden = Boolean(query) && !(option.textContent ?? '').toLowerCase().includes(query);
      if (!option.hidden) shown += 1;
    }
    count.hidden = !query;
    count.textContent = `${shown} OF ${all.length} ${config.noun}`;
  };

  input.addEventListener('input', filter);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      // Enter takes the first match, the one the eye is already on.
      event.preventDefault();
      options().find((option) => !option.hidden)?.click();
    } else if (event.key === 'Escape' && input.value) {
      // The first Escape clears the search; only the next one closes the list.
      event.preventDefault();
      event.stopPropagation();
      input.value = '';
      filter();
    }
  });

  return {
    decorate: () => {
      const on = active();
      root.classList.toggle('listbox--searchable', on);
      if (on) { list.prepend(row); list.append(count); } else { row.remove(); count.remove(); }
      filter();
    },
    /** Opens on an empty search, with the caret in it. */
    open: (): HTMLElement | null => {
      if (!active()) return null;
      input.value = '';
      filter();
      return input;
    },
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

  // Filtered-out options are hidden, and the keyboard walks only what is shown.
  const items = () => Array.from(list.querySelectorAll<HTMLButtonElement>('[role="option"]')).filter((item) => !item.hidden);

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
    const custom = config.onOpen?.();
    if (custom) { custom.focus(); return; }
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
    } else if ((event.key === 'Home' || event.key === 'End') && !(event.target instanceof HTMLInputElement)) {
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
      // Wrapped so a long label can end in an ellipsis inside the flex row.
      const label = doc.createElement('span');
      label.className = 'select-option-label';
      label.textContent = option.label;
      item.append(label);
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
