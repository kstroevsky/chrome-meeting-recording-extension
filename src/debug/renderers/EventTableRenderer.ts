/**
 * @file debug/renderers/EventTableRenderer.ts
 *
 * Manages incremental rendering of the perf events table inside the debug
 * dashboard. Appends new rows to the DOM without re-rendering existing rows,
 * and auto-scrolls when the user is near the bottom.
 */

import { escapeHtml, formatEventFields, formatTimestamp } from '../debugDashboardText';
import type { PerfEventEntry, PerfDebugSnapshot } from '../../shared/perf';

export class EventTableRenderer {
  private renderedEventCount = 0;

  constructor(
    private readonly eventsBodyEl: HTMLTableSectionElement | null,
    private readonly eventsScrollEl: HTMLElement | null
  ) {}

  /** Updates the table to reflect the latest entries, reset if the prefix differs. */
  update(entries: PerfEventEntry[], previousSnapshot: PerfDebugSnapshot | null) {
    if (!this.eventsBodyEl) return;

    const shouldReset = previousSnapshot == null
      || entries.length < this.renderedEventCount
      || !this.sameEntryPrefix(entries, previousSnapshot.entries, this.renderedEventCount);

    if (shouldReset) {
      this.reset();
    }

    if (entries.length === this.renderedEventCount) return;

    const wasNearBottom = this.isNearBottom();
    const fragment = document.createDocumentFragment();
    for (const entry of entries.slice(this.renderedEventCount)) {
      fragment.appendChild(this.createRow(entry));
    }

    this.eventsBodyEl.appendChild(fragment);
    this.renderedEventCount = entries.length;

    if (wasNearBottom || shouldReset) {
      this.scrollToBottom();
    }
  }

  /** Clears all rows and resets the rendered count. */
  reset() {
    this.renderedEventCount = 0;
    if (this.eventsBodyEl) this.eventsBodyEl.innerHTML = '';
    if (this.eventsScrollEl) this.eventsScrollEl.scrollTop = 0;
  }

  private sameEntryPrefix(
    nextEntries: PerfEventEntry[],
    previousEntries: PerfEventEntry[],
    count: number
  ): boolean {
    for (let i = 0; i < count; i += 1) {
      const next = nextEntries[i];
      const previous = previousEntries[i];
      if (
        !next
        || !previous
        || next.ts !== previous.ts
        || next.source !== previous.source
        || next.scope !== previous.scope
        || next.event !== previous.event
      ) {
        return false;
      }
    }
    return true;
  }

  private createRow(entry: PerfEventEntry): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.innerHTML = [
      `<td>${escapeHtml(formatTimestamp(entry.ts))}</td>`,
      `<td>${escapeHtml(entry.source)}</td>`,
      `<td>${escapeHtml(entry.scope)}</td>`,
      `<td>${escapeHtml(entry.event)}</td>`,
      `<td>${escapeHtml(formatEventFields(entry))}</td>`,
    ].join('');
    return row;
  }

  private isNearBottom(): boolean {
    const container = this.eventsScrollEl;
    if (!container) return true;
    return (container.scrollHeight - container.scrollTop - container.clientHeight) <= 24;
  }

  private scrollToBottom() {
    const container = this.eventsScrollEl;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }
}
