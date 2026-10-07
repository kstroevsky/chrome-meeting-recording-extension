import { normalizeRecordingContext } from '../recordingContext';

describe('recording context destination profile', () => {
  const base = { recordingId: 'r1', startedAt: 10, source: { kind: 'tab' } };

  it('keeps the profile picked at Start through normalization', () => {
    expect(normalizeRecordingContext({ ...base, destinationProfileId: 'profile-crm' }))
      .toEqual({ ...base, destinationProfileId: 'profile-crm' });
  });

  it('omits it for contexts written before destinations existed', () => {
    expect(normalizeRecordingContext(base)).toEqual(base);
  });

  it('survives finishing the recording', () => {
    const finished = normalizeRecordingContext({ ...normalizeRecordingContext({ ...base, destinationProfileId: 'p' }), endedAt: 20 });
    expect(finished).toEqual({ ...base, endedAt: 20, destinationProfileId: 'p' });
  });
});
