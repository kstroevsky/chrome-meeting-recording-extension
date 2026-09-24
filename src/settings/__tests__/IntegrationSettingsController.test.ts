import { IntegrationSettingsController } from '../IntegrationSettingsController';
import { requestHostPermission } from '../../platform/chrome/permissions';
import { sendToBackground } from '../../shared/messages';

jest.mock('../../platform/chrome/permissions', () => ({
  requestHostPermission: jest.fn(),
}));

jest.mock('../../shared/messages', () => ({
  sendToBackground: jest.fn(),
}));

const permission = requestHostPermission as jest.MockedFunction<typeof requestHostPermission>;
const send = sendToBackground as jest.MockedFunction<typeof sendToBackground>;

function mount(): IntegrationSettingsController {
  document.body.innerHTML = `
    <input id="integration-name">
    <input id="integration-endpoint">
    <select id="integration-routing"><option value="manual">Manual</option></select>
    <select id="integration-auth-type">
      <option value="none">None</option>
      <option value="api-key">API key</option>
    </select>
    <input id="integration-auth-header">
    <input id="integration-auth-value">
    <select id="integration-speakers"><option value="pseudonyms">Pseudonyms</option></select>
    <input type="checkbox" data-integration-create-policy="transcript" checked>
    <button id="integration-add">Add</button>
    <div id="integration-list"></div>
    <select id="integration-send-recording"></select>
    <p id="integration-status"></p>
    <div id="integration-secret-panel" hidden></div>
    <input id="integration-signing-secret">
  `;
  return IntegrationSettingsController.fromDocument(document);
}

function destination() {
  return {
    id: 'destination_1',
    producerId: 'producer_1',
    name: 'CRM',
    type: 'webhook' as const,
    enabled: true,
    endpoint: 'https://crm.example.test/hooks/recordings',
    routingDefault: 'manual' as const,
    dataPolicy: {
      metadata: true,
      meetingIdentity: false,
      userNote: false,
      notations: false,
      transcript: true,
      analysis: false,
      artifactMetadata: false,
      artifactLinks: false,
      transcriptSpeakers: 'pseudonyms' as const,
    },
    requestAuth: { type: 'none' as const },
    signingSecretId: 'secret_1',
    connectionVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('IntegrationSettingsController', () => {
  beforeEach(() => {
    permission.mockReset().mockResolvedValue(true);
    send.mockReset().mockImplementation(async (message: any) => {
      switch (message.type) {
        case 'LIST_RECORDING_HISTORY':
          return { ok: true, entries: [{ id: 'recording_1', name: 'Weekly sync' }] } as any;
        case 'LIST_INTEGRATIONS':
          return { ok: true, destinations: [destination()] } as any;
        case 'LIST_INTEGRATION_DELIVERIES':
          return { ok: true, deliveries: [] } as any;
        default:
          throw new Error(`Unexpected message ${message.type}`);
      }
    });
  });

  it('loads recordings before rendering destination send actions', async () => {
    await mount().init();
    expect((document.getElementById('integration-send-recording') as HTMLSelectElement).value).toBe('recording_1');
    expect((document.querySelector('.integration-destination__actions button:last-child') as HTMLButtonElement).disabled)
      .toBe(false);
  });

  it('rejects reserved API-key headers before requesting host permission', async () => {
    const controller = mount();
    await controller.init();
    (document.getElementById('integration-name') as HTMLInputElement).value = 'CRM';
    (document.getElementById('integration-endpoint') as HTMLInputElement).value = 'https://crm.example.test/hooks';
    (document.getElementById('integration-auth-type') as HTMLSelectElement).value = 'api-key';
    (document.getElementById('integration-auth-header') as HTMLInputElement).value = 'Webhook-Signature';
    (document.getElementById('integration-auth-value') as HTMLInputElement).value = 'secret-value';

    (document.getElementById('integration-add') as HTMLButtonElement).click();
    await Promise.resolve();

    expect(permission).not.toHaveBeenCalled();
    expect(document.getElementById('integration-status')?.textContent).toContain('conflicts with protocol headers');
  });

  it('requests only the endpoint origin and exposes the generated signing secret once', async () => {
    const controller = mount();
    await controller.init();
    (document.getElementById('integration-name') as HTMLInputElement).value = 'CRM';
    (document.getElementById('integration-endpoint') as HTMLInputElement).value = 'https://crm.example.test/hooks/recordings';
    send.mockImplementation(async (message: any) => {
      if (message.type === 'CREATE_INTEGRATION') {
        return { ok: true, created: { destination: destination(), signingSecret: 'whsec_generated' } } as any;
      }
      if (message.type === 'LIST_INTEGRATIONS') return { ok: true, destinations: [destination()] } as any;
      if (message.type === 'LIST_INTEGRATION_DELIVERIES') return { ok: true, deliveries: [] } as any;
      if (message.type === 'LIST_RECORDING_HISTORY') {
        return { ok: true, entries: [{ id: 'recording_1', name: 'Weekly sync' }] } as any;
      }
      throw new Error(`Unexpected message ${message.type}`);
    });

    (document.getElementById('integration-add') as HTMLButtonElement).click();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(permission).toHaveBeenCalledWith('https://crm.example.test/*');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'CREATE_INTEGRATION',
      input: expect.objectContaining({ endpoint: 'https://crm.example.test/hooks/recordings' }),
    }));
    expect((document.getElementById('integration-signing-secret') as HTMLInputElement).value).toBe('whsec_generated');
    expect((document.getElementById('integration-secret-panel') as HTMLElement).hidden).toBe(false);
  });
});
