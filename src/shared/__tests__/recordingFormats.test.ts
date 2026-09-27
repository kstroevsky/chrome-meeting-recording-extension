import {
  contentTypeForRecordingFile,
  contentTypeForRecordingFilename,
  normalizeRecordingFileContentType,
  getRecordingFormatCapabilities,
  isWebmRecordingFilename,
  resolveCameraRecordingProfile,
  resolveMicrophoneRecordingProfile,
  resolveTabRecordingProfile,
} from '../recordingFormats';

describe('recording output formats', () => {
  it('prefers compatible MP4 candidates, then permits a browser-selected MP4 profile', () => {
    const preferred = resolveTabRecordingProfile('mp4', true, (mime) => mime === 'video/mp4;codecs=vp9,opus');
    expect(preferred).toEqual(expect.objectContaining({
      recorderMimeType: 'video/mp4;codecs=vp9,opus',
      contentType: 'video/mp4',
      extension: 'mp4',
    }));

    const generic = resolveCameraRecordingProfile('mp4', (mime) => mime === 'video/mp4');
    expect(generic).toEqual(expect.objectContaining({ recorderMimeType: 'video/mp4', extension: 'mp4' }));
  });

  it('does not silently downgrade unavailable MP4 or M4A selections', () => {
    expect(resolveTabRecordingProfile('mp4', true, () => false)).toBeNull();
    expect(resolveCameraRecordingProfile('mp4', () => false)).toBeNull();
    expect(resolveMicrophoneRecordingProfile('m4a', () => false)).toBeNull();
  });

  it('keeps the existing WebM fallback behavior for the default format', () => {
    expect(resolveTabRecordingProfile('webm', true, () => false)).toEqual(expect.objectContaining({
      recorderMimeType: 'video/webm',
      contentType: 'video/webm',
      extension: 'webm',
    }));
    expect(resolveMicrophoneRecordingProfile('webm', () => false)).toEqual(expect.objectContaining({
      recorderMimeType: 'audio/webm',
      contentType: 'audio/webm',
    }));
  });

  it('reports each settings control independently', () => {
    const caps = getRecordingFormatCapabilities((mime) =>
      mime === 'video/mp4;codecs=vp9' || mime === 'audio/mp4;codecs=mp4a.40.2'
    );
    // The settings page requires a tab's normal audio-bearing profile, even if
    // this browser could encode a video-only MP4 recording.
    expect(caps).toEqual({ tabMp4: false, cameraMp4: true, microphoneM4a: true });
  });

  it('maps output extensions to upload content types and only repairs WebM duration metadata', () => {
    expect(contentTypeForRecordingFilename('meeting-recording.mp4')).toBe('video/mp4');
    expect(contentTypeForRecordingFilename('meeting-mic.m4a')).toBe('audio/mp4');
    expect(contentTypeForRecordingFilename('meeting-recording.webm')).toBe('video/webm');
    expect(isWebmRecordingFilename('meeting-recording.webm')).toBe(true);
    expect(isWebmRecordingFilename('meeting-recording.mp4')).toBe(false);
  });

  it('labels a microphone file as audio, which the name alone cannot tell', () => {
    expect(contentTypeForRecordingFile('meeting-mic.webm', 'mic')).toBe('audio/webm');
    expect(contentTypeForRecordingFile('meeting-mic.m4a', 'mic')).toBe('audio/mp4');
    expect(contentTypeForRecordingFile('meeting-recording.webm', 'tab')).toBe('video/webm');
    expect(contentTypeForRecordingFile('meeting-self-video.mp4', 'self-video')).toBe('video/mp4');
    expect(contentTypeForRecordingFile('meeting-notes.vtt', 'mic')).toBe('text/vtt');
  });

  it('reads a stored microphone video/… type as the audio it is, and keeps every other stored type', () => {
    expect(normalizeRecordingFileContentType('video/webm', 'meeting-mic.webm', 'mic')).toBe('audio/webm');
    expect(normalizeRecordingFileContentType('audio/webm', 'meeting-mic.webm', 'mic')).toBe('audio/webm');
    expect(normalizeRecordingFileContentType('video/webm', 'meeting-recording.webm', 'tab')).toBe('video/webm');
    expect(normalizeRecordingFileContentType(undefined, 'meeting-mic.webm', 'mic')).toBe('audio/webm');
  });
});
