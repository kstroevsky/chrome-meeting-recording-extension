import { sendToBackground } from '../../shared/messages';
import { IntegrationPreviewController } from '../IntegrationPreviewController';

jest.mock('../../shared/messages', () => ({
  sendToBackground: jest.fn(),
}));

const send = sendToBackground as jest.MockedFunction<typeof sendToBackground>;

function mount(): IntegrationPreviewController {
  document.body.innerHTML = `
    <select id="integration-preview-recording"></select>
    <p id="integration-preview-meta"></p>
    <textarea id="integration-preview-output"></textarea>
    <button id="integration-preview-build">Preview</button>
    <button id="integration-preview-download">Download</button>
    <p id="integration-preview-status"></p>
    <select id="integration-preview-speakers"><option value="pseudonyms">Pseudonyms</option></select>
  `;
  return IntegrationPreviewController.fromDocument(document);
}

describe('IntegrationPreviewController', () => {
  beforeEach(() => send.mockReset());

  it('keeps legacy recordings visible but unavailable for preview', async () => {
    send.mockResolvedValue({
      ok: true,
      recordings: [{
        id: 'legacy:1',
        name: 'Legacy recording',
        available: false,
        unavailableReason: 'missing-recording-context',
      }],
    } as any);

    await mount().init();

    const select = document.getElementById('integration-preview-recording') as HTMLSelectElement;
    const preview = document.getElementById('integration-preview-build') as HTMLButtonElement;
    expect(send).toHaveBeenCalledWith({ type: 'LIST_INTEGRATION_RECORDINGS' });
    expect(select.options[0].disabled).toBe(true);
    expect(select.options[0].textContent).toContain('missing recording context');
    expect(select.value).toBe('');
    expect(preview.disabled).toBe(true);
    expect(document.getElementById('integration-preview-status')?.textContent).toContain('predate recording context');
  });
});
