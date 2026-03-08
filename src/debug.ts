import { DebugDashboard } from './debug/DebugDashboard';

const dashboard = new DebugDashboard({
  buildBadgeEl: document.getElementById('debug-build-badge'),
  updatedAtEl: document.getElementById('debug-updated-at'),
  summaryEl: document.getElementById('debug-summary'),
  recorderEl: document.getElementById('debug-recorder'),
  uploadEl: document.getElementById('debug-upload'),
  captionsEl: document.getElementById('debug-captions'),
  runtimeEl: document.getElementById('debug-runtime'),
  eventsBodyEl: document.getElementById('debug-events-body') as HTMLTableSectionElement | null,
  downloadBtn: document.getElementById('download-debug-json') as HTMLButtonElement | null,
});

dashboard.init();
