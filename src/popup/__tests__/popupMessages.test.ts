import {
  buildDiscardConfirmMessage,
  buildLocalSaveFailedAlert,
  buildLocalSaveFailedToast,
  buildMicPermissionError,
  buildSavedLocallyMessage,
  buildStartErrorAlert,
  buildStopErrorAlert,
  buildTranscriptFilename,
} from '../popupMessages';

describe('popupMessages', () => {
  describe('buildSavedLocallyMessage', () => {
    it('uses the provided filename', () => {
      expect(buildSavedLocallyMessage('tab.webm')).toBe('Saved locally: tab.webm');
    });

    it('falls back to a default filename', () => {
      expect(buildSavedLocallyMessage()).toBe('Saved locally: recording.webm');
    });
  });

  describe('buildLocalSaveFailedToast', () => {
    it('includes filename and error', () => {
      expect(buildLocalSaveFailedToast('tab.webm', 'disk full')).toBe('Local save failed: tab.webm (disk full)');
    });

    it('falls back for missing filename and error', () => {
      expect(buildLocalSaveFailedToast()).toBe('Local save failed: recording.webm (Unknown save error)');
    });
  });

  describe('buildLocalSaveFailedAlert', () => {
    it('renders a multi-line alert with filename and error', () => {
      expect(buildLocalSaveFailedAlert('tab.webm', 'denied')).toBe('Failed to save tab.webm locally:\ndenied');
    });

    it('falls back for missing values', () => {
      expect(buildLocalSaveFailedAlert()).toBe('Failed to save recording.webm locally:\nUnknown save error');
    });
  });

  describe('start/stop error alerts', () => {
    it('extracts the message from an Error instance', () => {
      expect(buildStartErrorAlert(new Error('boom'))).toBe('Failed to start recording:\nboom');
      expect(buildStopErrorAlert(new Error('halt'))).toBe('Failed to stop recording:\nhalt');
    });

    it('stringifies non-Error values', () => {
      expect(buildStartErrorAlert('plain string')).toBe('Failed to start recording:\nplain string');
      expect(buildStopErrorAlert(42)).toBe('Failed to stop recording:\n42');
    });
  });

  describe('buildMicPermissionError', () => {
    it('explains mixing when mode is mixed', () => {
      expect(buildMicPermissionError('mixed')).toContain('mix your voice into the tab recording');
    });

    it('explains the separate file for separate and off modes', () => {
      expect(buildMicPermissionError('separate')).toContain('separate microphone file');
      expect(buildMicPermissionError('off')).toContain('separate microphone file');
    });
  });

  describe('buildTranscriptFilename', () => {
    it('uses the meeting id when available', () => {
      expect(buildTranscriptFilename('abc-defg-hij', 1700)).toBe('google-meet-transcript-abc-defg-hij-1700.txt');
    });

    it('falls back to a generic suffix without a meeting id', () => {
      expect(buildTranscriptFilename(undefined, 1700)).toBe('google-meet-transcript-google-meet-1700.txt');
    });
  });
});

describe('buildDiscardConfirmMessage', () => {
  it('names the elapsed time so the stakes are concrete', () => {
    expect(buildDiscardConfirmMessage('00:22:40'))
      .toBe("You'll lose 22:40 of video, audio, and the live transcript. This can't be undone.");
  });

  it('adds notes to the list only when the run has some', () => {
    expect(buildDiscardConfirmMessage('05:00', 0)).toContain('video, audio, and the live transcript.');
    expect(buildDiscardConfirmMessage('05:00', 3))
      .toContain('video, audio, the live transcript, and your notes.');
  });

  it('falls back to zero when the timer has produced nothing yet', () => {
    expect(buildDiscardConfirmMessage(undefined)).toContain("lose 0:00 of");
  });
});
