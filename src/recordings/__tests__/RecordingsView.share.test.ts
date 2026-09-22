import { RecordingsView, type RecordingsViewCallbacks } from '../RecordingsView';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import { historyFile } from '../../../tests/helpers/recordingHistoryFixtures';

function entry(): RecordingHistoryEntry {
  return {
    id: 'recording-one',
    name: 'Customer interview',
    createdAt: 1,
    storageMode: 'local',
    status: 'complete',
    files: [historyFile({
      id: 'recording-one:tab',
      stream: 'tab',
      filename: 'customer.webm',
      destination: 'local',
      status: 'available',
    })],
  };
}

function mount(share: RecordingsViewCallbacks['share'], revokeShare?: RecordingsViewCallbacks['revokeShare']) {
  const list = document.createElement('div');
  const empty = document.createElement('div');
  const error = document.createElement('div');
  const loadMore = document.createElement('button');
  document.body.replaceChildren(list, empty, error, loadMore);
  const callbacks = {
    rename: jest.fn(), note: jest.fn(), remove: jest.fn(), removeMany: jest.fn(),
    openLocal: jest.fn(), fileTo: jest.fn(), play: jest.fn(), loadMore: jest.fn(),
    share,
    revokeShare,
  } as unknown as RecordingsViewCallbacks;
  const view = new RecordingsView(list, empty, error, loadMore, callbacks);
  view.render([entry()]);
  return { list };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('RecordingsView sharing', () => {
  it('publishes selected recordings with privacy-preserving defaults', async () => {
    const share = jest.fn(async () => ({
      shareId: 'share-id',
      shareUrl: 'https://sharing.example/s/capability',
    }));
    const { list } = mount(share);
    list.querySelector<HTMLButtonElement>('.recording-row .selection-box')!.click();

    const shareButton = Array.from(list.querySelectorAll<HTMLButtonElement>('.bulk-button'))
      .find((button) => button.textContent === 'Share')!;
    expect(shareButton.hidden).toBe(false);
    shareButton.click();
    expect(document.querySelector('.share-dialog')).not.toBeNull();

    const labels = Array.from(document.querySelectorAll<HTMLLabelElement>('.share-dialog__option'));
    const states = Object.fromEntries(labels.map((label) => [
      label.querySelector('strong')!.textContent,
      label.querySelector<HTMLInputElement>('input')!.checked,
    ]));
    expect(states).toEqual({ Transcript: true, Topics: true, Notes: false, 'Self camera': false });

    Array.from(document.querySelectorAll<HTMLButtonElement>('.share-dialog__button'))
      .find((button) => button.textContent === 'Create link')!.click();
    await flush();

    expect(share).toHaveBeenCalledWith(['recording-one'], {
      includeTranscript: true,
      includeTopics: true,
      includeNotations: false,
      includeSelfVideo: false,
    }, expect.any(Function));
    expect(document.querySelector<HTMLInputElement>('.share-dialog__link')?.value)
      .toBe('https://sharing.example/s/capability');
  });

  it('revokes the created link through the durable owner lifecycle', async () => {
    const share = jest.fn(async () => ({ shareId: 'share-id', shareUrl: 'https://sharing.example/s/capability' }));
    const revoke = jest.fn(async () => {});
    const { list } = mount(share, revoke);
    list.querySelector<HTMLButtonElement>('.recording-row .selection-box')!.click();
    Array.from(list.querySelectorAll<HTMLButtonElement>('.bulk-button'))
      .find((button) => button.textContent === 'Share')!.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>('.share-dialog__button'))
      .find((button) => button.textContent === 'Create link')!.click();
    await flush();

    Array.from(document.querySelectorAll<HTMLButtonElement>('.share-dialog__button'))
      .find((button) => button.textContent === 'Revoke')!.click();
    await flush();

    expect(revoke).toHaveBeenCalledWith('share-id');
    expect(document.querySelector('.share-dialog__status')?.textContent).toContain('Link revoked');
  });
});
