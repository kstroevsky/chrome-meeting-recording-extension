import { DestinationSettingsController } from '../DestinationSettingsController';
import { sendToBackground } from '../../shared/messages';

jest.mock('../../shared/messages', () => ({ sendToBackground: jest.fn() }));
const send = sendToBackground as jest.MockedFunction<typeof sendToBackground>;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const builtin = (id: string, name: string) => ({
  id, name, kind: 'builtin', storageMode: id === 'builtin:drive' ? 'drive' : 'local', filesLabel: name, dataRoutes: [], available: true,
});
const crmProfile = {
  id: 'profile-crm', name: 'CheekyCheeseIT', kind: 'custom', storageMode: 'local',
  filesLabel: 'Local downloads', dataRoutes: [{ destinationId: 'destination_crm', destinationName: 'CheekyCheeseIT CRM' }], available: true,
};
const integration = (id: string, name: string, media = false) => ({
  id,
  name,
  enabled: true,
  endpoint: 'https://crm.example.test/hook',
  ...(media ? {
    media: {
      secretId: `media-${id}`,
      capability: {
        version: 1,
        apiBase: 'https://crm.example.test/api/media',
        upload: { strategy: 'multipart-put-v1', origins: ['https://objects.example.test'] },
        playback: { strategy: 'refreshable-url-v1' },
      },
    },
  } : {}),
});

function mount(state: { destinations: object[]; integrations: object[] }) {
  document.body.innerHTML = `
    <div id="save-to-list"></div>
    <div id="save-to-add-row">
      <input id="save-to-name">
      <select id="save-to-media"><option value="local">Local</option><option value="drive">Drive</option></select>
      <select id="save-to-folder"></select>
      <select id="save-to-integration" multiple></select>
      <button id="save-to-add" type="button">Add destination</button>
    </div>
    <p id="save-to-status"></p>`;
  send.mockReset().mockImplementation(async (message: any) => {
    switch (message.type) {
      case 'LIST_RECORDING_DESTINATIONS': return { ok: true, destinations: state.destinations } as any;
      case 'LIST_INTEGRATIONS': return { ok: true, destinations: state.integrations } as any;
      case 'SAVE_RECORDING_DESTINATION': {
        const routeNames = message.input.dataRoutes.map((route: any) => ({
          destinationId: route.destinationId,
          destinationName: (state.integrations as any[]).find((item) => item.id === route.destinationId)?.name ?? null,
        }));
        const name = message.input.name ?? 'New destination';
        state.destinations = [...state.destinations, {
          id: 'profile-new',
          name,
          kind: 'custom',
          storageMode: message.input.mediaTarget.kind,
          filesLabel: message.input.mediaTarget.kind === 'drive' ? 'Google Drive' : 'Local downloads',
          dataRoutes: routeNames,
          available: true,
        }];
        return { ok: true, profile: { id: 'profile-new', name } } as any;
      }
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
    name: document.getElementById('save-to-name') as HTMLInputElement,
    media: document.getElementById('save-to-media') as HTMLSelectElement,
    integration: document.getElementById('save-to-integration') as HTMLSelectElement,
    folder: document.getElementById('save-to-folder') as HTMLSelectElement,
    add: document.getElementById('save-to-add') as HTMLButtonElement,
    status: document.getElementById('save-to-status'),
  }, {
    folders: async () => ({
      local: [{ id: 'local-folder-1', name: 'Interviews' }],
      drive: [{ id: 'drive-folder-1', name: 'Recruiting' }],
    }),
  });
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[data-destination-profile]'))
  .map((row) => `${row.querySelector('strong')?.textContent} | ${row.querySelector('small')?.textContent}`);

describe('DestinationSettingsController', () => {
  it('lists built-ins and custom profiles with where files and data go', async () => {
    await mount({
      destinations: [builtin('builtin:drive', 'Google Drive'), builtin('builtin:local', 'Local downloads'), crmProfile],
      integrations: [integration('destination_crm', 'CheekyCheeseIT CRM')],
    }).init();

    expect(rows()).toEqual([
      'Google Drive | Built in',
      'Local downloads | Built in',
      'CheekyCheeseIT | Files: Local downloads · Data: CheekyCheeseIT CRM',
    ]);
    expect(document.querySelectorAll('[data-destination-profile] button')).toHaveLength(1);
    expect(document.getElementById('save-to-add-row')!.hidden).toBe(false);
  });

  it('creates a named local profile with a folder and several data routes', async () => {
    await mount({
      destinations: [builtin('builtin:local', 'Local downloads')],
      integrations: [integration('destination_crm', 'CheekyCheeseIT CRM'), integration('destination_journal', 'Journal')],
    }).init();

    const name = document.getElementById('save-to-name') as HTMLInputElement;
    const routes = document.getElementById('save-to-integration') as HTMLSelectElement;
    const folder = document.getElementById('save-to-folder') as HTMLSelectElement;
    name.value = 'Interview archive';
    for (const option of Array.from(routes.options)) option.selected = true;
    expect(Array.from(folder.options).map((option) => option.textContent)).toEqual([
      'Files: Local downloads', 'Files: Local downloads / Interviews',
    ]);
    folder.value = 'local-folder-1';
    document.getElementById('save-to-add')!.click();
    await flush();

    expect(send).toHaveBeenCalledWith({
      type: 'SAVE_RECORDING_DESTINATION',
      input: {
        name: 'Interview archive',
        mediaTarget: { kind: 'local', folderPresetId: 'local-folder-1' },
        dataRoutes: [
          { destinationId: 'destination_crm', mode: 'auto' },
          { destinationId: 'destination_journal', mode: 'auto' },
        ],
      },
    });
    expect(document.getElementById('save-to-status')!.textContent).toBe('Added Interview archive. Pick it under Save to before you record.');
  });

  it('switches folder choices with the selected media target and allows no data routes', async () => {
    await mount({ destinations: [builtin('builtin:drive', 'Google Drive')], integrations: [] }).init();
    const media = document.getElementById('save-to-media') as HTMLSelectElement;
    const folder = document.getElementById('save-to-folder') as HTMLSelectElement;
    media.value = 'drive';
    media.dispatchEvent(new Event('change'));
    await flush();
    expect(Array.from(folder.options).map((option) => option.textContent)).toEqual([
      'Files: Google Drive', 'Files: Google Drive / Recruiting',
    ]);
    folder.value = 'drive-folder-1';
    document.getElementById('save-to-add')!.click();
    await flush();
    expect(send).toHaveBeenCalledWith({
      type: 'SAVE_RECORDING_DESTINATION',
      input: { mediaTarget: { kind: 'drive', folderPresetId: 'drive-folder-1' }, dataRoutes: [] },
    });
  });

  it('offers media-capable integrations as primary media without selecting them for data', async () => {
    await mount({
      destinations: [builtin('builtin:local', 'Local downloads')],
      integrations: [integration('destination_crm', 'CheekyCheeseIT CRM', true)],
    }).init();
    const media = document.getElementById('save-to-media') as HTMLSelectElement;
    const folder = document.getElementById('save-to-folder') as HTMLSelectElement;
    expect(Array.from(media.options).map((option) => option.textContent)).toContain('Files: CheekyCheeseIT CRM');

    media.value = 'external:destination_crm';
    media.dispatchEvent(new Event('change'));
    await flush();
    expect(folder.disabled).toBe(true);
    expect(Array.from(folder.options).map((option) => option.textContent)).toEqual(['Files: CheekyCheeseIT CRM']);

    document.getElementById('save-to-add')!.click();
    await flush();
    expect(send).toHaveBeenCalledWith({
      type: 'SAVE_RECORDING_DESTINATION',
      input: {
        mediaTarget: { kind: 'external', destinationId: 'destination_crm' },
        dataRoutes: [],
      },
    });
  });

  it('removes a custom destination and says what that does not change', async () => {
    await mount({
      destinations: [builtin('builtin:local', 'Local downloads'), crmProfile],
      integrations: [integration('destination_crm', 'CheekyCheeseIT CRM')],
    }).init();
    document.querySelector<HTMLButtonElement>('[data-destination-profile="profile-crm"] button')!.click();
    await flush();

    expect(send).toHaveBeenCalledWith({ type: 'REMOVE_RECORDING_DESTINATION', profileId: 'profile-crm' });
    expect(rows()).toEqual(['Local downloads | Built in']);
    expect(document.getElementById('save-to-status')!.textContent).toContain('Recordings already made with it are not affected.');
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
