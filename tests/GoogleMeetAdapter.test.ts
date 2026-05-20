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

  it('recognizes an active meeting from the leave-call control', () => {
    const leaveButton = document.createElement('button');
    leaveButton.setAttribute('aria-label', 'Leave call');
    document.body.appendChild(leaveButton);

    expect(adapter.getMeetingLifecycleState(document)).toBe('active');
  });

  it('recognizes a post-call state from ended meeting text', () => {
    document.body.textContent = 'You left the meeting Rejoin';

    expect(adapter.getMeetingLifecycleState(document)).toBe('ended');
  });
});
