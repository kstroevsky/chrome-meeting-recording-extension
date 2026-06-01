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

  it('reports an unknown lifecycle state when no controls or ended text are present', () => {
    document.body.textContent = 'Meeting in progress, audio connected';
    expect(adapter.getMeetingLifecycleState(document)).toBe('unknown');
  });

  it('detects ended state from a non-Document root via textContent', () => {
    const root = document.createElement('div');
    root.textContent = 'This meeting has ended';
    expect(adapter.getMeetingLifecycleState(root)).toBe('ended');
  });

  describe('caption DOM helpers', () => {
    function makeBlock(opts: { id?: string; speaker?: string; text?: string | null } = {}): HTMLElement {
      const block = document.createElement('div');
      block.className = 'nMcdL';
      if (opts.id) block.setAttribute('data-participant-id', opts.id);
      if (opts.speaker !== undefined) {
        const speaker = document.createElement('div');
        speaker.className = 'NWpY1d';
        speaker.textContent = opts.speaker;
        block.appendChild(speaker);
      }
      if (opts.text !== null) {
        const text = document.createElement('div');
        text.className = 'ygicle';
        text.textContent = opts.text ?? 'hello';
        block.appendChild(text);
      }
      return block;
    }

    it('finds the captions region, or null when absent', () => {
      expect(adapter.findCaptionsRegion(document)).toBeNull();
      const region = document.createElement('div');
      region.setAttribute('role', 'region');
      region.setAttribute('aria-label', 'Captions');
      document.body.appendChild(region);
      expect(adapter.findCaptionsRegion(document)).toBe(region);
    });

    it('collects caption blocks within a container', () => {
      const container = document.createElement('div');
      container.appendChild(makeBlock({ id: 'u1' }));
      container.appendChild(makeBlock({ id: 'u2' }));
      expect(adapter.collectCaptionBlocks(container)).toHaveLength(2);
    });

    it('includes the node itself when it is a caption block', () => {
      const block = makeBlock({ id: 'u1' });
      expect(adapter.collectCaptionBlocks(block)).toEqual([block]);
    });

    it('returns an empty list for non-element nodes', () => {
      expect(adapter.collectCaptionBlocks(document.createTextNode('text'))).toEqual([]);
    });

    it('extracts caption block data keyed by participant id', () => {
      const block = makeBlock({ id: 'user-7', speaker: 'John Doe', text: 'Hi' });
      const data = adapter.getCaptionBlockData(block);
      expect(data).toMatchObject({ key: 'user-7', speakerName: 'John Doe' });
      expect(data?.textNode.textContent).toBe('Hi');
    });

    it('falls back to the speaker name as the key when no participant id exists', () => {
      const block = makeBlock({ speaker: 'Jane Doe' });
      expect(adapter.getCaptionBlockData(block)?.key).toBe('Jane Doe');
    });

    it('returns null when the block has no caption text node', () => {
      const block = makeBlock({ id: 'u1', speaker: 'John', text: null });
      expect(adapter.getCaptionBlockData(block)).toBeNull();
    });
  });
});
