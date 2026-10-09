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
    const destinationMediaTarget = { kind: 'drive' as const, folderPresetId: 'drive-folder-1' };
    const destinationRoutes = [{ destinationId: 'destination_crm', mode: 'auto' as const }];
    const finished = normalizeRecordingContext({
      ...normalizeRecordingContext({
        ...base,
        destinationProfileId: 'p',
        destinationMediaTarget,
        destinationRoutes,
      }),
      endedAt: 20,
    });
    expect(finished).toEqual({
      ...base,
      endedAt: 20,
      destinationProfileId: 'p',
      destinationMediaTarget,
      destinationRoutes,
    });
  });

  it('keeps an explicitly empty route snapshot', () => {
    expect(normalizeRecordingContext({
      ...base,
      destinationMediaTarget: { kind: 'local', folderPresetId: 'folder-1' },
      destinationRoutes: [],
    })).toEqual({
      ...base,
      destinationMediaTarget: { kind: 'local', folderPresetId: 'folder-1' },
      destinationRoutes: [],
    });
  });

  it.each([
    [[{ destinationId: 'destination_crm', mode: 'review' }]],
    [[
      { destinationId: 'destination_crm', mode: 'auto' },
      { destinationId: 'destination_crm', mode: 'auto' },
    ]],
  ])('drops an invalid route snapshot rather than broadening it (%p)', (destinationRoutes) => {
    expect(normalizeRecordingContext({ ...base, destinationRoutes })).toEqual(base);
  });
});
