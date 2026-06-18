jest.mock('../../platform/chrome/tabs', () => ({
  addTabRemovedListener: jest.fn(),
  addTabUpdatedListener: jest.fn(),
}));

import {
  handleMeetingEndedMessage,
  registerRecordingAutoStop,
} from '../recordingAutoStop';
import { addTabRemovedListener, addTabUpdatedListener } from '../../platform/chrome/tabs';
import type { RecordingSessionSnapshot } from '../../shared/recording';

const RECORDING_SNAPSHOT: RecordingSessionSnapshot = {
  phase: 'recording',
  runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
  targetTabId: 42,
  meetingSlug: 'meet-abc-defg-hij',
  updatedAt: Date.now(),
};

function makeDeps(snapshot: RecordingSessionSnapshot, stopResult: any = { ok: true }) {
  const stop = jest.fn().mockResolvedValue(stopResult);
  const deps = {
    session: { getSnapshot: () => snapshot } as any,
    controller: { stop } as any,
  };
  return { deps, stop };
}

describe('handleMeetingEndedMessage', () => {
  const sender = { tab: { id: 42 } } as chrome.runtime.MessageSender;

  it('stops when the tab and meeting both match', async () => {
    const { deps, stop } = makeDeps(RECORDING_SNAPSHOT);

    const result = await handleMeetingEndedMessage(
      { type: 'MEETING_ENDED', meetingId: 'abc-defg-hij', reason: 'post-call state detected' },
      sender,
      deps
    );

    expect(stop).toHaveBeenCalledWith('meeting ended: post-call state detected');
    expect(result).toEqual({ ok: true, stopped: true, reason: 'meeting ended: post-call state detected' });
  });

  it('uses a generic reason when none is provided', async () => {
    const { deps, stop } = makeDeps(RECORDING_SNAPSHOT);

    const result = await handleMeetingEndedMessage(
      { type: 'MEETING_ENDED', meetingId: 'abc-defg-hij' },
      sender,
      deps
    );

    expect(stop).toHaveBeenCalledWith('meeting ended');
    expect(result).toEqual({ ok: true, stopped: true, reason: 'meeting ended' });
  });

  it('ignores a meeting id that does not match the recorded meeting', async () => {
    const { deps, stop } = makeDeps(RECORDING_SNAPSHOT);

    const result = await handleMeetingEndedMessage(
      { type: 'MEETING_ENDED', meetingId: 'other-meet' },
      sender,
      deps
    );

    expect(result).toEqual({ ok: true, stopped: false, reason: 'meeting-mismatch' });
    expect(stop).not.toHaveBeenCalled();
  });

  it('ignores a message from a tab that is not the recorded tab', async () => {
    const { deps, stop } = makeDeps(RECORDING_SNAPSHOT);

    const result = await handleMeetingEndedMessage(
      { type: 'MEETING_ENDED', meetingId: 'abc-defg-hij' },
      { tab: { id: 99 } } as chrome.runtime.MessageSender,
      deps
    );

    expect(result).toEqual({ ok: true, stopped: false, reason: 'not-recording-target' });
    expect(stop).not.toHaveBeenCalled();
  });

  it('surfaces a controller stop failure', async () => {
    const { deps } = makeDeps(RECORDING_SNAPSHOT, { ok: false, error: 'stop boom' });

    const result = await handleMeetingEndedMessage(
      { type: 'MEETING_ENDED', meetingId: 'abc-defg-hij' },
      sender,
      deps
    );

    expect(result).toEqual({ ok: false, stopped: false, error: 'stop boom' });
  });

  it('does not stop when the session is no longer in a stoppable phase', async () => {
    const { deps, stop } = makeDeps({ ...RECORDING_SNAPSHOT, phase: 'uploading' });

    const result = await handleMeetingEndedMessage(
      { type: 'MEETING_ENDED', meetingId: 'abc-defg-hij' },
      sender,
      deps
    );

    expect(result).toEqual({ ok: true, stopped: false, reason: 'not-recording-target' });
    expect(stop).not.toHaveBeenCalled();
  });
});

describe('registerRecordingAutoStop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function register(snapshot: RecordingSessionSnapshot) {
    const { deps, stop } = makeDeps(snapshot);
    registerRecordingAutoStop(deps);
    const onRemoved = (addTabRemovedListener as jest.Mock).mock.calls[0][0];
    const onUpdated = (addTabUpdatedListener as jest.Mock).mock.calls[0][0];
    return { onRemoved, onUpdated, stop };
  }

  it('stops when the recorded tab is closed', () => {
    const { onRemoved, stop } = register(RECORDING_SNAPSHOT);
    onRemoved(42, { windowId: 1, isWindowClosing: false });
    expect(stop).toHaveBeenCalledWith('recorded tab closed');
  });

  it('ignores closure of an unrelated tab', () => {
    const { onRemoved, stop } = register(RECORDING_SNAPSHOT);
    onRemoved(7, { windowId: 1, isWindowClosing: false });
    expect(stop).not.toHaveBeenCalled();
  });

  it('stops when the recorded tab navigates away from the meeting', () => {
    const { onUpdated, stop } = register(RECORDING_SNAPSHOT);
    onUpdated(42, { url: 'https://example.com/' }, { id: 42 });
    expect(stop).toHaveBeenCalledWith('recorded tab navigated away from meeting');
  });

  it('does not stop when the URL update keeps the same meeting slug', () => {
    const { onUpdated, stop } = register(RECORDING_SNAPSHOT);
    onUpdated(42, { url: 'https://meet.google.com/abc-defg-hij' }, { id: 42 });
    expect(stop).not.toHaveBeenCalled();
  });

  it('ignores tab updates without a URL change', () => {
    const { onUpdated, stop } = register(RECORDING_SNAPSHOT);
    onUpdated(42, { status: 'complete' }, { id: 42 });
    expect(stop).not.toHaveBeenCalled();
  });

  it('treats a malformed URL as leaving the meeting (slug parses to null)', () => {
    const { onUpdated, stop } = register(RECORDING_SNAPSHOT);
    onUpdated(42, { url: 'not a valid url' }, { id: 42 });
    expect(stop).toHaveBeenCalledWith('recorded tab navigated away from meeting');
  });
});
