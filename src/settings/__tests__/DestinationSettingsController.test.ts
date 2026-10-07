import { DestinationSettingsController } from '../DestinationSettingsController';
import { sendToBackground } from '../../shared/messages';

jest.mock('../../shared/messages', () => ({ sendToBackground: jest.fn() }));
const send = sendToBackground as jest.MockedFunction<typeof sendToBackground>;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const builtin = (id: string, name: string) => ({
  id, name, kind: 'builtin', storageMode: id === 'builtin:drive' ? 'drive' : 'local', filesLabel: name, dataRoutes: [], available: true,
});
const crmProfile = {
  id: 'profile-crm', name: 'CheekyCheeseIT', kind: 'integration', storageMode: 'local',
  filesLabel: 'Local downloads', dataRoutes: [{ destinationId: 'destination_crm', destinationName: 'CheekyCheeseIT CRM' }], available: true,
};
const integration = (id: string, name: string) => ({ id, name, enabled: true, endpoint: 'https://crm.example.test/hook' });

function mount(state: { destinations: object[]; integrations: object[] }) {
  document.body.innerHTML = `
    <div id="save-to-list"></div>
    <div id="save-to-add-row" hidden>
      <select id="save-to-integration"></select>
      <select id="save-to-folder"></select>
      <button id="save-to-add" type="button">Add destination</button>
    </div>
    <p id="save-to-status"></p>`;
  send.mockReset().mockImplementation(async (message: any) => {
    switch (message.type) {
      case 'LIST_RECORDING_DESTINATIONS': return { ok: true, destinations: state.destinations } as any;
      case 'LIST_INTEGRATIONS': return { ok: true, destinations: state.integrations } as any;
      case 'SAVE_RECORDING_DESTINATION':
        state.destinations = [...state.destinations, { ...crmProfile, id: 'profile-new', name: 'Journal', dataRoutes: [{ destinationId: message.input.destinationId, destinationName: 'Journal' }] }];
        return { ok: true, profile: { id: 'profile-new', name: 'Journal' } } as any;
      case 'REMOVE_RECORDING_DESTINATION':
        state.destinations = state.destinations.filter((option: any) => option.id !== message.profileId);
        return { ok: true, removed: true } as any;
      default: throw new Error(`Unexpected message ${message.type}`);
    }
  });
  return new DestinationSettingsController({
    document,
    list: document.getElementById('save-to-list'),
    addRow: document.getElementById('save-to-add-row'),
    integration: document.getElementById('save-to-integration') as HTMLSelectElement,
    folder: document.getElementById('save-to-folder') as HTMLSelectElement,
    add: document.getElementById('save-to-add') as HTMLButtonElement,
    status: document.getElementById('save-to-status'),
  }, { localFolders: async () => [{ id: 'folder-1', name: 'Interviews' }] });
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-destination-profile]'))
  .map((row) => `${row.querySelector('strong')?.textContent} | ${row.querySelector('small')?.textContent}`);

describe('DestinationSettingsController', () => {
  it('lists the built-ins and integration destinations with where files and data go', async () => {
    await mount({
      destinations: [builtin('builtin:drive', 'Google Drive'), builtin('builtin:local', 'Local downloads'), crmProfile],
      integrations: [integration('destination_crm', 'CheekyCheeseIT CRM')],
    }).init();

    expect(rows()).toEqual([
      'Google Drive | Built in',
      'Local downloads | Built in',
      'CheekyCheeseIT | Files: Local downloads · Data: CheekyCheeseIT CRM',
    ]);
    // Only an integration's destination can be removed.
    expect(document.querySelectorAll('[data-destination-profile] button')).toHaveLength(1);
    // Every integration already has a destination: nothing to add.
    expect(document.getElementById('save-to-add-row')!.hidden).toBe(true);
  });

  it('offers to add a destination for an integration without one, into a chosen folder', async () => {
    await mount({
      destinations: [builtin('builtin:local', 'Local downloads'), crmProfile],
      integrations: [integration('destination_crm', 'CheekyCheeseIT CRM'), integration('destination_journal', 'Journal')],
    }).init();

    const pick = document.getElementById('save-to-integration') as HTMLSelectElement;
    const folder = document.getElementById('save-to-folder') as HTMLSelectElement;
    expect(Array.from(pick.options).map((option) => option.value)).toEqual(['destination_journal']);
    expect(Array.from(folder.options).map((option) => option.textContent)).toEqual([
      'Files: Local downloads', 'Files: Local downloads / Interviews',
    ]);
    folder.value = 'folder-1';
    document.getElementById('save-to-add')!.click();
    await flush();

    expect(send).toHaveBeenCalledWith({
      type: 'SAVE_RECORDING_DESTINATION',
      input: { destinationId: 'destination_journal', localFolderPresetId: 'folder-1' },
    });
    expect(document.getElementById('save-to-status')!.textContent).toBe('Added Journal. Pick it under Save to before you record.');
    expect(document.getElementById('save-to-add-row')!.hidden).toBe(true);
  });

  it('removes an integration destination and says what that does not change', async () => {
    await mount({
      destinations: [builtin('builtin:local', 'Local downloads'), crmProfile],
      integrations: [integration('destination_crm', 'CheekyCheeseIT CRM')],
    }).init();
    document.querySelector<HTMLButtonElement>('[data-destination-profile="profile-crm"] button')!.click();
    await flush();

    expect(send).toHaveBeenCalledWith({ type: 'REMOVE_RECORDING_DESTINATION', profileId: 'profile-crm' });
    expect(rows()).toEqual(['Local downloads | Built in']);
    expect(document.getElementById('save-to-status')!.textContent).toContain('Recordings already made with it are not affected.');
    // The integration is still connected, so it can be added back.
    expect(document.getElementById('save-to-add-row')!.hidden).toBe(false);
  });

  it('marks a destination that cannot be picked, with the reason', async () => {
    await mount({
      destinations: [{ ...crmProfile, available: false, unavailableReason: 'destination-disabled' }],
      integrations: [],
    }).init();
    expect(rows()).toEqual(['CheekyCheeseIT | Integration disabled · fix in Settings']);
    expect(document.querySelector('.integration-destination--unavailable')).not.toBeNull();
  });
});
