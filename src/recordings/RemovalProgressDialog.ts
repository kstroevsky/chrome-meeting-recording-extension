/**
 * @file recordings/RemovalProgressDialog.ts
 *
 * What removing several recordings is doing, while it does it.
 *
 * The removal runs from this page, one recording at a time, and each one can
 * mean network calls (ending shares, trashing Drive files). So the dialog says
 * how far it is, which recording it is on, and — plainly — that the page must
 * stay open: closing or reloading it stops the run after the recording in
 * progress, and the rest stay in the library. The browser's own "Leave site?"
 * prompt backs that up while the run lasts.
 *
 * One recording failing does not stop the others; every problem is listed as
 * it happens and again in the closing summary. "Stop" finishes the recording
 * in progress and then stops, so nothing is left half-removed.
 */

export type RemovalProgress = {
  /** The recording about to be removed; `index` counts from 0. */
  start(name: string, index: number): void;
  /** It is out of the library; `fileErrors` are files that could not be deleted. */
  removed(name: string, fileErrors?: readonly string[], filesDeleted?: number): void;
  /** It could not be removed and is still in the library. */
  failed(name: string, reason: string): void;
  /** The user asked to stop after the recording in progress. */
  readonly stopRequested: boolean;
  /** The run is over: summarise, let the page be left, and offer Close. */
  finish(): RemovalSummary;
};

export type RemovalSummary = {
  total: number;
  removed: number;
  failed: number;
  fileErrors: number;
  stopped: boolean;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
};

const recordings = (n: number) => `${n} recording${n === 1 ? '' : 's'}`;
const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

export function openRemovalProgress(total: number, deleteFiles: boolean): RemovalProgress {
  const overlay = el('div', 'confirm-overlay');
  const card = el('div', 'confirm-card sync-card removal-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const title = el('span', 'confirm-card__title', `Removing ${recordings(total)}${deleteFiles ? ' and their files' : ''}`);
  title.id = 'removal-progress-title';
  card.setAttribute('aria-labelledby', title.id);

  const keepOpen = el('p', 'removal-note', 'Keep this page open until it finishes. Removal runs from this page: closing or reloading it stops after the recording in progress, and the rest stay in your library.');
  const track = el('div', 'removal-progress');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(total));
  track.setAttribute('aria-valuenow', '0');
  track.setAttribute('aria-labelledby', title.id);
  const bar = el('span', 'removal-progress__bar');
  track.append(bar);
  const status = el('p', 'removal-status');
  status.setAttribute('aria-live', 'polite');

  const problemsBlock = el('section', 'sync-section removal-problems');
  const problemsLabel = el('div', 'detail-section-label');
  const problems = el('ul', 'sync-list');
  problemsBlock.append(problemsLabel, problems);
  problemsBlock.hidden = true;

  const body = el('div', 'sync-body');
  body.append(keepOpen, track, status, problemsBlock);

  const actions = el('div', 'confirm-card__actions');
  const stop = el('button', 'confirm-card__cancel', 'Stop after this one');
  stop.type = 'button';
  const close = el('button', 'sync-apply', 'Close');
  close.type = 'button';
  close.hidden = true;
  actions.append(stop, close);
  card.append(title, body, actions);
  overlay.append(card);

  let done = 0;
  let removedCount = 0;
  let failedCount = 0;
  let fileErrorCount = 0;
  let filesDeletedCount = 0;
  let stopRequested = false;
  let finished = false;
  let summary: RemovalSummary | null = null;

  const setProgress = () => {
    track.setAttribute('aria-valuenow', String(done));
    bar.style.width = `${total ? Math.round((done / total) * 100) : 100}%`;
  };
  const problem = (text: string) => {
    problems.append(el('li', undefined, text));
    problemsBlock.hidden = false;
    const count = problems.childElementCount;
    problemsLabel.textContent = `Problems — ${count}`;
  };

  // The browser's own prompt: the last guard against leaving mid-run.
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  const dismiss = () => {
    if (!finished) return;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    dismiss();
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss(); });
  close.addEventListener('click', dismiss);
  stop.addEventListener('click', () => {
    stopRequested = true;
    stop.disabled = true;
    stop.textContent = 'Stopping…';
  });

  setProgress();
  status.textContent = `0 of ${total}`;
  document.body.append(overlay);
  stop.focus();

  return {
    start(name, index) {
      status.textContent = `${index + 1} of ${total} · Removing “${name}”…`;
    },
    removed(name, fileErrors = [], filesDeleted = 0) {
      done += 1;
      removedCount += 1;
      filesDeletedCount += filesDeleted;
      fileErrorCount += fileErrors.length;
      for (const error of fileErrors) problem(`“${name}” was removed, but a file could not be deleted — ${error}`);
      setProgress();
    },
    failed(name, reason) {
      done += 1;
      failedCount += 1;
      problem(`“${name}” was not removed and is still in your library — ${reason}`);
      setProgress();
    },
    get stopRequested() {
      return stopRequested;
    },
    finish() {
      if (summary) return summary;
      finished = true;
      window.removeEventListener('beforeunload', onBeforeUnload);
      const left = total - done;
      const stopped = stopRequested && left > 0;
      title.textContent = stopped
        ? `Stopped — removed ${removedCount} of ${recordings(total)}`
        : `Removed ${removedCount} of ${recordings(total)}`;
      keepOpen.remove();
      status.textContent = [
        deleteFiles ? `${files(filesDeletedCount)} deleted.` : '',
        stopped ? `The other ${recordings(left)} ${left === 1 ? 'is' : 'are'} still in your library.` : '',
        failedCount ? `${recordings(failedCount)} could not be removed.` : '',
        fileErrorCount ? `${files(fileErrorCount)} could not be deleted.` : '',
        !stopped && !failedCount && !fileErrorCount ? 'Done.' : '',
      ].filter(Boolean).join(' ');
      stop.hidden = true;
      close.hidden = false;
      close.focus();
      summary = { total, removed: removedCount, failed: failedCount, fileErrors: fileErrorCount, stopped };
      return summary;
    },
  };
}
