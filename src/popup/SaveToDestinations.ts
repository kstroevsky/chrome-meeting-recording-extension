/**
 * @file popup/SaveToDestinations.ts
 *
 * Fills the popup's "Save to" list with the user's custom destinations.
 *
 * The two built-ins (Google Drive, Local downloads) stay authored in
 * popup.html with their legacy select values; custom profiles are added
 * after them, before the divider, as `profile:<id>` values. The background
 * owns the profiles and their availability; this module only renders what
 * LIST_RECORDING_DESTINATIONS returns.
 */

import type { RecordingDestinationOption } from '../background/destinations/RecordingDestinationsRuntime';
import { saveToValueOf } from '../shared/recordingDestinations';
import { describeDestination } from '../shared/recordingDestinationLabels';

export { describeDestination };

const RENDERED = 'data-destination-profile';
/** A plain arrow-into-box glyph: "this also sends somewhere". */
const ROUTE_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 8h7.5M7.5 5l3 3-3 3M11.5 3.5h1A1.5 1.5 0 0114 5v6a1.5 1.5 0 01-1.5 1.5h-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Replaces previously rendered integration entries with the current ones. */
export function renderSaveToDestinations(
  select: HTMLSelectElement,
  list: HTMLElement,
  options: readonly RecordingDestinationOption[],
): void {
  const doc = select.ownerDocument;
  const stale = [...Array.from(select.querySelectorAll(`[${RENDERED}]`)), ...Array.from(list.querySelectorAll(`[${RENDERED}]`))];
  for (const element of stale) {
    element.remove();
  }
  const divider = list.querySelector('.select-divider');
  for (const option of options) {
    if (option.kind !== 'custom') continue;
    const value = saveToValueOf(option.id);

    const native = doc.createElement('option');
    native.value = value;
    native.textContent = option.name;
    native.disabled = !option.available;
    native.dataset.storageMode = option.storageMode;
    native.setAttribute(RENDERED, option.id);
    select.appendChild(native);

    const button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(select.value === value));
    button.dataset.value = value;
    button.disabled = !option.available;
    button.setAttribute(RENDERED, option.id);
    button.innerHTML = ROUTE_ICON;
    const text = doc.createElement('span');
    text.className = 'select-option-text';
    const name = doc.createElement('span');
    name.textContent = option.name;
    const detail = doc.createElement('small');
    detail.className = 'select-option-detail';
    detail.textContent = describeDestination(option);
    text.append(name, detail);
    button.appendChild(text);
    list.insertBefore(button, divider);
  }
}
