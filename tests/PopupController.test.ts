import { PopupController } from '../src/popup/PopupController';
import { MicPermissionService } from '../src/popup/MicPermissionService';

jest.mock('../src/popup/MicPermissionService');

describe('PopupController', () => {
  let controller: PopupController;
  let elements: any;
  let mockSendMessage: jest.Mock;
  let mockTabsQuery: jest.Mock;

  beforeEach(() => {
    elements = {
      saveBtn: document.createElement('button'),
      micBtn: document.createElement('button'),
      startBtn: document.createElement('button'),
      stopBtn: document.createElement('button'),
      storageModeSelect: document.createElement('select')
    };
    
    const optLocal = document.createElement('option');
    optLocal.value = 'local';
    const optDrive = document.createElement('option');
    optDrive.value = 'drive';
    elements.storageModeSelect.appendChild(optLocal);
    elements.storageModeSelect.appendChild(optDrive);

    mockSendMessage = chrome.runtime.sendMessage as jest.Mock;
    mockSendMessage.mockResolvedValue({ ok: true });

    mockTabsQuery = chrome.tabs.query as jest.Mock;
    mockTabsQuery.mockResolvedValue([{ id: 101, url: 'https://meet.google.com/abc-defg' }]);

    controller = new PopupController(elements);
    // Suppress console error output for tests evaluating thrown exceptions
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(window, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('initializes UI correctly from existing recording state', async () => {
    mockSendMessage.mockResolvedValueOnce({ recording: true });
    controller.init();
    
    // Allow async refreshInitialUi to resolve
    await new Promise(process.nextTick);

    expect(mockSendMessage).toHaveBeenCalledWith({ type: 'GET_RECORDING_STATUS' });
    expect(elements.startBtn.disabled).toBe(true);
    expect(elements.stopBtn.disabled).toBe(false);
    expect(elements.storageModeSelect.disabled).toBe(true);
  });

  it('handles START_RECORDING click', async () => {
    controller.init();
    await new Promise(process.nextTick); // let init settle

    elements.storageModeSelect.selectedIndex = 1;

    // Simulate click
    elements.startBtn.click();
    
    // Wait for the async click handler
    await new Promise(process.nextTick);

    // Verify messages sent
    expect(mockTabsQuery).toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(101, { type: 'RESET_TRANSCRIPT' });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'START_RECORDING',
      tabId: 101,
      storageMode: 'drive'
    });

    expect(elements.startBtn.disabled).toBe(true);
    expect(elements.stopBtn.disabled).toBe(false);
  });

  it('handles STOP_RECORDING click', async () => {
    // Start with recording state
    mockSendMessage.mockResolvedValueOnce({ recording: true });
    controller.init();
    await new Promise(process.nextTick);
    
    // Send message mock for STOP_RECORDING
    mockSendMessage.mockResolvedValueOnce({ ok: true });
    
    elements.stopBtn.click();
    await new Promise(process.nextTick);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'STOP_RECORDING' });
  });
});
