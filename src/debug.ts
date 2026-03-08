/**
 * @context  Diagnostics Page
 * @role     Entry point that wires DOM nodes into `DebugDashboard`.
 * @lifetime Lives for the lifetime of `debug.html`.
 */

import { DebugDashboard } from './debug/DebugDashboard';

const dashboard = new DebugDashboard({
  buildBadgeEl: document.getElementById('debug-build-badge'),
  updatedAtEl: document.getElementById('debug-updated-at'),
  summaryEl: document.getElementById('debug-summary'),
  recorderEl: document.getElementById('debug-recorder'),
  uploadEl: document.getElementById('debug-upload'),
  captionsEl: document.getElementById('debug-captions'),
  runtimeEl: document.getElementById('debug-runtime'),
  systemEl: document.getElementById('debug-system'),
  eventsScrollEl: document.getElementById('debug-events-scroll'),
  eventsBodyEl: document.getElementById('debug-events-body') as HTMLTableSectionElement | null,
  downloadBtn: document.getElementById('download-debug-json') as HTMLButtonElement | null,
});

dashboard.init();
window.addEventListener('beforeunload', () => dashboard.destroy(), { once: true });
