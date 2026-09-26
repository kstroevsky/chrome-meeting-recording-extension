/**
 * The dialog is the only place a long removal explains itself, so what it says
 * — and when it lets the page be left — is the contract under test.
 */
import { openRemovalProgress as openDialog, type RemovalProgress } from '../RemovalProgressDialog';

/** Every dialog is finished after its test, so none leaves its leave-guard behind. */
const opened: RemovalProgress[] = [];
const openRemovalProgress = (total: number, deleteFiles: boolean) => {
  const progress = openDialog(total, deleteFiles);
  opened.push(progress);
  return progress;
};

const card = () => document.querySelector<HTMLElement>('.removal-card')!;
const bar = () => card().querySelector<HTMLElement>('.removal-progress__bar')!;
const track = () => card().querySelector<HTMLElement>('[role=progressbar]')!;
const status = () => card().querySelector<HTMLElement>('.removal-status')!.textContent;
const button = (label: string) => Array.from(card().querySelectorAll('button')).find((b) => b.textContent === label)!;
const leaveBlocked = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

beforeEach(() => document.body.replaceChildren());
afterEach(() => { opened.splice(0).forEach((progress) => progress.finish()); });

describe('removal progress dialog', () => {
  it('says how far it is, which recording it is on, and to keep the page open', () => {
    const progress = openRemovalProgress(4, true);
    expect(card().textContent).toContain('Removing 4 recordings and their files');
    expect(card().textContent).toContain('Keep this page open until it finishes');
    expect(track().getAttribute('aria-valuemax')).toBe('4');

    progress.start('Standup', 0);
    expect(status()).toBe('1 of 4 · Removing “Standup”…');
    progress.removed('Standup', [], 2);
    expect(track().getAttribute('aria-valuenow')).toBe('1');
    expect(bar().style.width).toBe('25%');
  });

  it('lists every problem as it happens and keeps going', () => {
    const progress = openRemovalProgress(3, true);
    progress.failed('Retro', 'Recording history is unavailable');
    progress.removed('Demo', ['Drive file demo.webm: Google Drive answered 403'], 0);
    progress.removed('Sync', [], 1);

    const problems = Array.from(card().querySelectorAll('.removal-problems li')).map((li) => li.textContent);
    expect(problems).toEqual([
      '“Retro” was not removed and is still in your library — Recording history is unavailable',
      '“Demo” was removed, but a file could not be deleted — Drive file demo.webm: Google Drive answered 403',
    ]);
    expect(card().textContent).toContain('Problems — 2');
    expect(bar().style.width).toBe('100%');
  });

  it('asks the browser to confirm leaving only while the run lasts', () => {
    const progress = openRemovalProgress(1, false);
    expect(leaveBlocked()).toBe(true);
    progress.removed('Standup');
    progress.finish();
    expect(leaveBlocked()).toBe(false);
  });

  it('cannot be dismissed mid-run, then summarises and closes', () => {
    const progress = openRemovalProgress(2, true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(card()).not.toBeNull();

    progress.removed('A', [], 1);
    progress.failed('B', 'offline');
    expect(progress.finish()).toEqual({ total: 2, removed: 1, failed: 1, fileErrors: 0, stopped: false });
    expect(card().querySelector('.confirm-card__title')!.textContent).toBe('Removed 1 of 2 recordings');
    expect(status()).toBe('1 file deleted. 1 recording could not be removed.');
    expect(card().textContent).not.toContain('Keep this page open');

    button('Close').click();
    expect(document.querySelector('.removal-card')).toBeNull();
  });

  it('stops after the recording in progress and says what is left', () => {
    const progress = openRemovalProgress(5, false);
    button('Stop after this one').click();
    expect(progress.stopRequested).toBe(true);
    expect(button('Stopping…').disabled).toBe(true);

    progress.removed('A');
    progress.removed('B');
    expect(progress.finish().stopped).toBe(true);
    expect(card().querySelector('.confirm-card__title')!.textContent).toBe('Stopped — removed 2 of 5 recordings');
    expect(status()).toBe('The other 3 recordings are still in your library.');
  });
});
