import { GoogleMeetAdapter } from '../src/content/GoogleMeetAdapter';

function makeLocation(pathname: string): Location {
  return { pathname } as Location;
}

describe('GoogleMeetAdapter', () => {
  const adapter = new GoogleMeetAdapter();

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reports localCameraEnabled=false when Meet exposes a turn on camera button', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Turn on camera');
    document.body.appendChild(button);

    expect(adapter.getProviderInfo(makeLocation('/abc-defg-hij'), document)).toEqual({
      providerId: 'google-meet',
      meetingId: 'abc-defg-hij',
      supportsCaptions: true,
      localCameraEnabled: false,
    });
  });

  it('reports localCameraEnabled=true when Meet exposes a turn off camera button', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Turn off your camera');
    document.body.appendChild(button);

    expect(adapter.getProviderInfo(makeLocation('/abc-defg-hij'), document)).toEqual({
      providerId: 'google-meet',
      meetingId: 'abc-defg-hij',
      supportsCaptions: true,
      localCameraEnabled: true,
    });
  });

  it('returns localCameraEnabled=null when the camera state cannot be determined', () => {
    const button = document.createElement('button');
    button.setAttribute('aria-label', 'Open more options');
    document.body.appendChild(button);

    expect(adapter.getProviderInfo(makeLocation('/abc-defg-hij'), document)).toEqual({
      providerId: 'google-meet',
      meetingId: 'abc-defg-hij',
      supportsCaptions: true,
      localCameraEnabled: null,
    });
  });
});
