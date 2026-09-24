import { normalizeRecordingContext, normalizeMeetingUrl } from '../recordingContext';

describe('recording context URL minimization', () => {
  it('drops Google Meet account routing query and fragment material', () => {
    expect(normalizeMeetingUrl(
      'https://meet.google.com/abc-defg-hij?authuser=2&hs=122#participant=private',
      'google-meet',
    )).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('applies the same minimization when normalizing durable context rows', () => {
    expect(normalizeRecordingContext({
      recordingId: 'rec:1',
      startedAt: 10,
      source: {
        kind: 'meeting',
        provider: 'google-meet',
        meetingId: 'abc-defg-hij',
        meetingUrl: 'https://meet.google.com/abc-defg-hij?authuser=1#private-state',
      },
    })?.source.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('preserves query material for an unknown provider whose meeting identity may depend on it', () => {
    expect(normalizeMeetingUrl(
      'https://meetings.example.test/join?room=private-id#client-state',
      'other-provider',
    )).toBe('https://meetings.example.test/join?room=private-id#client-state');
  });
});
