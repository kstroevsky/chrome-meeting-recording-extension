import { GoogleMeetAdapter } from '../src/content/GoogleMeetAdapter';

function makeLocation(pathname: string): Location {
  return { pathname } as Location;
}

describe('GoogleMeetAdapter', () => {
  const adapter = new GoogleMeetAdapter();

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns provider metadata without camera state', () => {
    expect(adapter.getProviderInfo(makeLocation('/abc-defg-hij'), document)).toEqual({
      providerId: 'google-meet',
      meetingId: 'abc-defg-hij',
      supportsCaptions: true,
    });
  });
});
