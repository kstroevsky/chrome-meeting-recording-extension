import { applyRunConfigToForm, buildRunConfigFromForm } from '../popupRunConfig';
import { describeDestination, renderSaveToDestinations } from '../SaveToDestinations';
import type { PopupElements } from '../popupView';
import type { RecordingDestinationOption } from '../../background/destinations/RecordingDestinationsRuntime';

const CRM: RecordingDestinationOption = {
  id: 'profile-crm',
  name: 'CheekyCheeseIT',
  kind: 'integration',
  storageMode: 'local',
  filesLabel: 'Local downloads',
  dataRoutes: [{ destinationId: 'destination_crm', destinationName: 'CheekyCheeseIT CRM' }],
  available: true,
};

function mount() {
  document.body.innerHTML = `
    <select id="storage-mode"><option value="local">Local disk</option><option value="drive" selected>Google Drive</option></select>
    <div id="storage-mode-options">
      <button role="option" data-value="drive">Google Drive</button>
      <button role="option" data-value="local">Local downloads</button>
      <span class="select-divider"></span>
      <button class="select-add">＋ Add destination…</button>
    </div>`;
  const select = document.getElementById('storage-mode') as HTMLSelectElement;
  const list = document.getElementById('storage-mode-options') as HTMLElement;
  return { select, list, elements: { storageModeSelect: select } as unknown as PopupElements };
}

describe('Save to destinations in the popup', () => {
  it('adds integration profiles before the divider, with a files and data line', () => {
    const { select, list } = mount();
    renderSaveToDestinations(select, list, [CRM]);

    const option = list.querySelector<HTMLButtonElement>('[data-destination-profile="profile-crm"]')!;
    expect(option.dataset.value).toBe('profile:profile-crm');
    expect(option.nextElementSibling?.classList.contains('select-divider')).toBe(true);
    expect(option.textContent).toContain('Files: Local downloads · Data: CheekyCheeseIT CRM');
    expect(select.querySelector<HTMLOptionElement>('option[value="profile:profile-crm"]')?.textContent).toBe('CheekyCheeseIT');
  });

  it('re-renders without duplicates and skips built-ins', () => {
    const { select, list } = mount();
    const builtin = { ...CRM, id: 'builtin:drive', kind: 'builtin' as const };
    renderSaveToDestinations(select, list, [builtin, CRM]);
    renderSaveToDestinations(select, list, [builtin, CRM]);
    expect(list.querySelectorAll('[data-destination-profile]')).toHaveLength(1);
    expect(select.options).toHaveLength(3);
  });

  it('shows an unavailable profile as disabled, saying how to fix it', () => {
    const { select, list } = mount();
    renderSaveToDestinations(select, list, [{ ...CRM, available: false, unavailableReason: 'permission-missing' }]);
    const option = list.querySelector<HTMLButtonElement>('[data-destination-profile]')!;
    expect(option.disabled).toBe(true);
    expect(describeDestination({ ...CRM, available: false, unavailableReason: 'permission-missing' }))
      .toBe('Needs site access · fix in Settings');
  });

  it('round-trips a profile pick between the run config and the form', () => {
    const { select, list, elements } = mount();
    renderSaveToDestinations(select, list, [CRM]);
    applyRunConfigToForm(elements, { storageMode: 'local', micMode: 'off', recordSelfVideo: false, destinationProfileId: 'profile-crm' });
    expect(select.value).toBe('profile:profile-crm');
    expect(buildRunConfigFromForm(elements)).toEqual(expect.objectContaining({
      storageMode: 'local', destinationProfileId: 'profile-crm',
    }));
  });

  it('falls back to the built-in storage when the remembered profile is not listed', () => {
    const { select, elements } = mount();
    applyRunConfigToForm(elements, { storageMode: 'local', micMode: 'off', recordSelfVideo: false, destinationProfileId: 'profile-gone' });
    expect(select.value).toBe('local');
    expect(buildRunConfigFromForm(elements)).toEqual(expect.objectContaining({ storageMode: 'local', destinationProfileId: 'builtin:local' }));
  });
});
