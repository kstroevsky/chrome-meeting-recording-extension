/**
 * @file settings/FolderPresetList.ts
 *
 * The repeating name-and-remove editor behind both destination lists: Google
 * Drive folders and download sub-folders. They are separate lists because they
 * are different places with different naming rules, but the editing is the
 * same, and a fix to one should never need making twice.
 *
 * Binding and applying are deliberately separate. `wire()` attaches the Add
 * handler once; `apply()` repaints from settings and is safe to call on every
 * load, save and reset. Folding the two together is what left "Reset to
 * defaults" showing destinations it had just erased from storage.
 */

import type { FolderPreset } from '../shared/settings';

export type FolderPresetListElements = {
  list?: HTMLElement | null;
  add?: HTMLButtonElement | null;
  note?: HTMLElement | null;
};

export type FolderPresetListConfig = {
  elements: FolderPresetListElements;
  maxPresets: number;
  maxNameLength: number;
  placeholder: string;
  /** Names the thing in labels and messages: "destination", "folder". */
  noun: string;
  /** Prefix for generated ids, so the two lists never mint colliding ones. */
  idPrefix: string;
};

export class FolderPresetList {
  private presets: FolderPreset[] = [];

  constructor(private readonly config: FolderPresetListConfig) {}

  /** Attaches the Add handler. Call once, at wire time. */
  wire(): void {
    this.config.elements.add?.addEventListener('click', () => {
      this.presets.push({ id: this.newId(), name: '' });
      this.render();
      // Focus the row just added; adding one and then hunting for it is silly.
      const inputs = this.config.elements.list?.querySelectorAll<HTMLInputElement>('.destination-name');
      inputs?.[inputs.length - 1]?.focus();
    });
  }

  /** Repaints from settings. Safe on every load, save and reset. */
  apply(presets: readonly FolderPreset[]): void {
    this.presets = presets.map((preset) => ({ ...preset }));
    this.render();
  }

  /** Blank rows are dropped here; the normalizer also drops them on load. */
  read(): FolderPreset[] {
    return this.presets.filter((preset) => preset.name.trim().length > 0);
  }

  private newId(): string {
    return `${this.config.idPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private render(): void {
    const { list, add, note } = this.config.elements;
    if (!list) return;
    list.replaceChildren();
    this.presets.forEach((preset, index) => {
      const row = document.createElement('div');
      row.className = 'destination-row';
      const input = document.createElement('input');
      input.className = 'destination-name';
      input.type = 'text';
      input.value = preset.name;
      input.maxLength = this.config.maxNameLength;
      input.placeholder = this.config.placeholder;
      input.setAttribute('aria-label', `${this.config.noun} ${index + 1} name`);
      // Kept in the model on every keystroke so saving never depends on blur.
      input.addEventListener('input', () => { this.presets[index].name = input.value; });
      const remove = document.createElement('button');
      remove.className = 'destination-remove';
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = `Remove ${this.config.noun}`;
      remove.setAttribute('aria-label', `Remove ${this.config.noun} ${index + 1}`);
      remove.addEventListener('click', () => {
        this.presets.splice(index, 1);
        this.render();
      });
      row.append(input, remove);
      list.append(row);
    });

    const full = this.presets.length >= this.config.maxPresets;
    if (add) add.disabled = full;
    if (note) {
      note.textContent = full ? `That is the maximum of ${this.config.maxPresets}.` : '';
      note.hidden = !full;
    }
  }
}
