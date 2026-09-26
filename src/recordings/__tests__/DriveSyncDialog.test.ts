/**
 * The dialog's defaults are a policy: corrections start ticked, bringing back
 * something the user removed never does, missing files are only reported.
 */
import { openDriveSyncDialog } from '../DriveSyncDialog';
import type { DriveSyncPlan } from '../../shared/driveSync';

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const PLAN: DriveSyncPlan = {
  moves: [{ historyId: 'h1', name: 'Therapy Jul 24', folderName: 'f', destination: 'Therapy' }],
  notInLibrary: [
    { folderId: 'folder-jul10', folderName: 'x', destination: 'Therapy', kind: 'removed', name: 'Jul 10' },
    { folderId: 'folder-new', folderName: 'y', destination: 'Rest', kind: 'new', name: 'New one' },
  ],
  missing: [{ historyId: 'h9', name: 'Sep 11 test', problem: 'in the Drive trash' }],
  durations: 3,
  leftAlone: [{ folder: 'mixed', destination: 'Rest', reason: 'more than one file per stream' }],
};
const card = () => document.querySelector<HTMLElement>('.sync-card')!;
const applyButton = () => card().querySelector<HTMLButtonElement>('.sync-apply')!;
const boxes = () => Array.from(card().querySelectorAll<HTMLInputElement>('input[type=checkbox]'));

beforeEach(() => document.body.replaceChildren());

describe('Sync with Drive dialog', () => {
  it('ticks corrections, leaves every bring-back unticked, and applies exactly the choice', async () => {
    const apply = jest.fn(async () => ({ moved: 1, broughtBack: 1, durations: 3, durationsUnreadable: 0 }));
    const done = openDriveSyncDialog({ plan: async () => PLAN, apply });
    expect(card().textContent).toContain('Checking Google Drive');
    await flush();

    expect(boxes().map((box) => box.checked)).toEqual([true, false, false, true]);
    expect(card().textContent).toContain('Sep 11 test — in the Drive trash');
    expect(card().textContent).toContain('Folders left alone — 1');

    boxes()[1].click();
    applyButton().click();
    await flush();
    expect(apply).toHaveBeenCalledWith({ moves: true, durations: true, bringBack: ['folder-jul10'] });
    expect(card().textContent).toContain('Done: 1 updated, 1 brought back, 3 durations filled in.');

    card().querySelector<HTMLButtonElement>('.confirm-card__cancel')!.click();
    await expect(done).resolves.toEqual({ moved: 1, broughtBack: 1, durations: 3, durationsUnreadable: 0 });
  });

  it('cannot apply an empty choice', async () => {
    void openDriveSyncDialog({ plan: async () => PLAN, apply: jest.fn() });
    await flush();
    boxes()[0].click();
    boxes()[3].click();
    expect(applyButton().disabled).toBe(true);
  });

  it('says so when everything already matches, and closes without a result', async () => {
    const done = openDriveSyncDialog({
      plan: async () => ({ moves: [], notInLibrary: [], missing: [], durations: 0, leftAlone: [] }),
      apply: jest.fn(),
    });
    await flush();
    expect(card().textContent).toContain('Everything matches Google Drive.');
    expect(applyButton().disabled).toBe(true);
    card().querySelector<HTMLButtonElement>('.confirm-card__cancel')!.click();
    await expect(done).resolves.toBeNull();
  });

  it('shows why Drive could not be checked', async () => {
    void openDriveSyncDialog({ plan: async () => { throw new Error('Google Drive answered 401'); }, apply: jest.fn() });
    await flush();
    expect(card().textContent).toContain('Could not check Google Drive: Google Drive answered 401');
  });
});
