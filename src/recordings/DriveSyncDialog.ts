/**
 * @file recordings/DriveSyncDialog.ts
 *
 * "Sync with Drive" on the Recordings page: checks Drive, shows what differs,
 * and applies only what the user ticks.
 *
 * Defaults follow what each change risks. Re-pointing moved recordings and
 * filling in durations only correct what the library says, so they start
 * ticked. Bringing a recording back reverses a removal the user may have meant,
 * so each one starts unticked. Missing files are reported, never acted on.
 */

import type { DriveSyncChoice, DriveSyncPlan, DriveSyncResult } from '../shared/driveSync';

export type DriveSyncDialogDeps = {
  plan: () => Promise<DriveSyncPlan>;
  apply: (choice: DriveSyncChoice) => Promise<DriveSyncResult>;
};

const SHOWN = 6;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
};

function checkbox(label: string, checked: boolean, detail?: string): { row: HTMLLabelElement; box: HTMLInputElement } {
  const row = el('label', 'sync-choice');
  const box = el('input', 'confirm-card__checkbox');
  box.type = 'checkbox';
  box.checked = checked;
  const text = el('span', 'sync-choice__text', label);
  if (detail) text.append(el('span', 'sync-muted', ` · ${detail}`));
  row.append(box, text);
  return { row, box };
}

function section(title: string, count: number): HTMLElement {
  const block = el('section', 'sync-section');
  block.append(el('div', 'detail-section-label', `${title} — ${count}`));
  return block;
}

function list(items: string[]): HTMLElement {
  const ul = el('ul', 'sync-list');
  for (const item of items.slice(0, SHOWN)) ul.append(el('li', undefined, item));
  if (items.length > SHOWN) ul.append(el('li', 'sync-muted', `and ${items.length - SHOWN} more`));
  return ul;
}

export function openDriveSyncDialog(deps: DriveSyncDialogDeps): Promise<DriveSyncResult | null> {
  return new Promise((resolve) => {
    const overlay = el('div', 'confirm-overlay');
    const card = el('div', 'confirm-card sync-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Sync with Google Drive');
    const title = el('span', 'confirm-card__title', 'Sync with Google Drive');
    const body = el('div', 'sync-body');
    const status = el('p', 'confirm-card__body', 'Checking Google Drive…');
    body.append(status);
    const actions = el('div', 'confirm-card__actions');
    const cancel = el('button', 'confirm-card__cancel', 'Cancel');
    const apply = el('button', 'sync-apply', 'Apply');
    cancel.type = 'button';
    apply.type = 'button';
    apply.disabled = true;
    actions.append(cancel, apply);
    card.append(title, body, actions);
    overlay.append(card);

    let result: DriveSyncResult | null = null;
    let busy = false;
    const close = () => {
      if (busy) return;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    document.body.append(overlay);
    cancel.focus();

    void deps.plan().then((plan) => {
      if (!overlay.isConnected) return;
      body.replaceChildren();
      const choose = {
        moves: null as HTMLInputElement | null,
        durations: null as HTMLInputElement | null,
        bringBack: [] as Array<{ box: HTMLInputElement; folderId: string }>,
      };

      if (plan.moves.length) {
        const block = section('Moved or re-filed in Drive', plan.moves.length);
        const { row, box } = checkbox('Update these recordings to where they are now', true);
        choose.moves = box;
        block.append(row, list(plan.moves.map((move) => `${move.name} → ${move.destination}`)));
        body.append(block);
      }
      if (plan.notInLibrary.length) {
        const block = section('In Drive, not in the library', plan.notInLibrary.length);
        block.append(el('p', 'sync-muted', 'Tick the ones to bring back. Removed ones were removed by you.'));
        for (const item of plan.notInLibrary) {
          const { row, box } = checkbox(item.name, false, `${item.destination} · ${item.kind === 'removed' ? 'removed earlier' : 'new'}`);
          choose.bringBack.push({ box, folderId: item.folderId });
          block.append(row);
        }
        body.append(block);
      }
      if (plan.durations) {
        const block = section('Without a duration', plan.durations);
        const { row, box } = checkbox('Read the duration from each file', true);
        choose.durations = box;
        block.append(row);
        body.append(block);
      }
      if (plan.missing.length) {
        const block = section('Files missing from Drive', plan.missing.length);
        block.append(
          el('p', 'sync-muted', 'Nothing is changed for these. Remove them from the library yourself if they are gone for good.'),
          list(plan.missing.map((item) => `${item.name} — ${item.problem}`)),
        );
        body.append(block);
      }
      if (plan.leftAlone.length) {
        const block = section('Folders left alone', plan.leftAlone.length);
        block.append(list(plan.leftAlone.map((item) => `${item.destination} / ${item.folder} — ${item.reason}`)));
        body.append(block);
      }
      if (!body.childElementCount) {
        body.append(el('p', 'confirm-card__body', 'Everything matches Google Drive.'));
        cancel.textContent = 'Close';
        return;
      }

      const current = (): DriveSyncChoice => ({
        moves: choose.moves?.checked ?? false,
        durations: choose.durations?.checked ?? false,
        bringBack: choose.bringBack.filter((item) => item.box.checked).map((item) => item.folderId),
      });
      const refresh = () => {
        const choice = current();
        apply.disabled = !choice.moves && !choice.durations && !choice.bringBack.length;
      };
      body.addEventListener('change', refresh);
      refresh();

      apply.addEventListener('click', () => {
        const choice = current();
        busy = true;
        apply.disabled = true;
        cancel.disabled = true;
        body.replaceChildren(el('p', 'confirm-card__body', choice.durations
          ? 'Applying… reading durations can take a minute.'
          : 'Applying…'));
        void deps.apply(choice).then((done) => {
          result = done;
          const said = [
            done.moved ? `${done.moved} updated` : '',
            done.broughtBack ? `${done.broughtBack} brought back` : '',
            done.durations ? `${done.durations} durations filled in` : '',
            done.durationsUnreadable ? `${done.durationsUnreadable} durations could not be read` : '',
          ].filter(Boolean);
          body.replaceChildren(el('p', 'confirm-card__body', said.length ? `Done: ${said.join(', ')}.` : 'Nothing needed changing.'));
        }, (error) => {
          body.replaceChildren(el('p', 'confirm-card__body sync-error', `Sync failed: ${error instanceof Error ? error.message : String(error)}`));
        }).finally(() => {
          busy = false;
          cancel.disabled = false;
          cancel.textContent = 'Close';
          apply.hidden = true;
          cancel.focus();
        });
      });
    }, (error) => {
      body.replaceChildren(el('p', 'confirm-card__body sync-error', `Could not check Google Drive: ${error instanceof Error ? error.message : String(error)}`));
      cancel.textContent = 'Close';
    });
  });
}
