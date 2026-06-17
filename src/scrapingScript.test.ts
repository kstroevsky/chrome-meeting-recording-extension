import { TIMEOUTS } from './shared/timeouts';

function createCaptionBlock(id: string, speaker: string, text: string): HTMLDivElement {
  const block = document.createElement('div');
  block.className = 'nMcdL';
  block.setAttribute('data-participant-id', id);

  const speakerEl = document.createElement('div');
  speakerEl.className = 'NWpY1d';
  speakerEl.textContent = speaker;

  const textEl = document.createElement('div');
  textEl.className = 'ygicle';
  textEl.textContent = text;

  block.appendChild(speakerEl);
  block.appendChild(textEl);
  return block;
}

function mountCaptionsRegion(...blocks: HTMLDivElement[]): HTMLElement {
  const region = document.createElement('div');
  region.setAttribute('role', 'region');
  region.setAttribute('aria-label', 'Captions');
  blocks.forEach((block) => region.appendChild(block));
  document.body.appendChild(region);
  return region;
}

function mountCaptionsRegionInWrapper(...blocks: HTMLDivElement[]): { wrapper: HTMLElement; region: HTMLElement } {
  const wrapper = document.createElement('div');
  const region = document.createElement('div');
  region.setAttribute('role', 'region');
  region.setAttribute('aria-label', 'Captions');
  blocks.forEach((block) => region.appendChild(block));
  wrapper.appendChild(region);
  document.body.appendChild(wrapper);
  return { wrapper, region };
}

function mountLeaveCallControl(): HTMLButtonElement {
  const button = document.createElement('button');
  button.setAttribute('aria-label', 'Leave call');
  document.body.appendChild(button);
  return button;
}

async function flushMutations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function getCollector(): any {
  return (window as any).collector;
}

describe('scrapingScript', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (globalThis as any).__DEV_BUILD__ = true;
    document.body.innerHTML = '';
    jest.resetModules();
    require('./scrapingScript');
    getCollector().start();
  });

  afterEach(() => {
    getCollector()?.stop?.();
    (globalThis as any).__DEV_BUILD__ = false;
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('collects transcripts when the captions region appears after startup', async () => {
    mountCaptionsRegion(createCaptionBlock('user1', 'John Doe', 'Hello world'));

    await flushMutations();
    jest.advanceTimersByTime(TIMEOUTS.CAPTION_GRACE_MS + 100);

    expect((window as any).getTranscript()).toContain('John Doe : Hello world');
  });

  it('re-arms region discovery when captions are toggled off and back on', async () => {
    const firstRegion = mountCaptionsRegion(createCaptionBlock('user1', 'John Doe', 'First line'));

    await flushMutations();
    expect(getCollector().getActiveBlockObserverCount()).toBe(1);
    jest.advanceTimersByTime(TIMEOUTS.CAPTION_GRACE_MS + 100);

    firstRegion.remove();
    await flushMutations();
    expect(getCollector().getActiveBlockObserverCount()).toBe(0);

    mountCaptionsRegion(createCaptionBlock('user2', 'Jane Doe', 'Second line'));
    await flushMutations();
    expect(getCollector().getActiveBlockObserverCount()).toBe(1);

    jest.advanceTimersByTime(TIMEOUTS.CAPTION_GRACE_MS + 100);
    const transcript = (window as any).getTranscript();
    expect(transcript).toContain('John Doe : First line');
    expect(transcript).toContain('Jane Doe : Second line');
  });

  it('reports caption-region presence via areCaptionsActive (drives the transcript chip)', async () => {
    expect(getCollector().areCaptionsActive()).toBe(false);

    const region = mountCaptionsRegion(createCaptionBlock('user1', 'John Doe', 'Hello'));
    await flushMutations();
    expect(getCollector().areCaptionsActive()).toBe(true);

    region.remove();
    await flushMutations();
    expect(getCollector().areCaptionsActive()).toBe(false);
  });

  it('deduplicates per-block observers when the same block is scanned repeatedly', async () => {
    const region = mountCaptionsRegion(createCaptionBlock('user1', 'John Doe', 'Hello world'));

    await flushMutations();
    const block = region.querySelector('.nMcdL') as HTMLElement;

    getCollector().scanSpeakerBlock(block);
    getCollector().scanSpeakerBlock(block);

    expect(getCollector().getActiveBlockObserverCount()).toBe(1);
  });

  it('does not duplicate transcript lines during repeated caption refinements', async () => {
    const region = mountCaptionsRegion(createCaptionBlock('user1', 'John Doe', 'Hello'));

    await flushMutations();

    const textNode = region.querySelector('.ygicle') as HTMLElement;
    textNode.textContent = 'Hello w';
    await flushMutations();
    textNode.textContent = 'Hello world';
    await flushMutations();
    textNode.textContent = 'Hello world';
    await flushMutations();

    jest.advanceTimersByTime(TIMEOUTS.CAPTION_GRACE_MS + 100);

    const lines = (window as any)
      .getTranscript()
      .split('\n')
      .filter((line: string) => line.trim());

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('John Doe : Hello world');
  });

  it('reports caption mutation processing and coalescing diagnostics', async () => {
    const region = mountCaptionsRegion(createCaptionBlock('user1', 'John Doe', 'Hello'));
    await flushMutations();
    (chrome.runtime.sendMessage as jest.Mock).mockClear();

    const textNode = region.querySelector('.ygicle') as HTMLElement;
    textNode.textContent = 'Hello world';
    await flushMutations();
    textNode.textContent = 'Hello world';
    await flushMutations();

    const perfMessages = (chrome.runtime.sendMessage as jest.Mock).mock.calls
      .map(([message]) => message)
      .filter((message) =>
        message?.type === 'PERF_EVENT'
        && message.entry?.scope === 'captions'
        && message.entry?.event === 'mutation_processed'
      );

    expect(perfMessages).toHaveLength(2);
    expect(perfMessages[0].entry.fields).toEqual(expect.objectContaining({
      changed: true,
      coalesced: false,
    }));
    expect(perfMessages[1].entry.fields).toEqual(expect.objectContaining({
      changed: false,
      coalesced: true,
    }));
  });

  it('cleans up block observers when caption blocks are removed', async () => {
    const block = createCaptionBlock('user1', 'John Doe', 'Hello world');
    mountCaptionsRegion(block);

    await flushMutations();
    expect(getCollector().getActiveBlockObserverCount()).toBe(1);

    block.remove();
    await flushMutations();

    expect(getCollector().getActiveBlockObserverCount()).toBe(0);
  });

  it('re-arms region discovery when the captions parent subtree is removed', async () => {
    const { wrapper } = mountCaptionsRegionInWrapper(createCaptionBlock('user1', 'John Doe', 'Hello world'));

    await flushMutations();
    expect(getCollector().getActiveBlockObserverCount()).toBe(1);

    wrapper.remove();
    await flushMutations();
    expect(getCollector().getActiveBlockObserverCount()).toBe(0);

    mountCaptionsRegion(createCaptionBlock('user2', 'Jane Doe', 'Second line'));
    await flushMutations();
    expect(getCollector().getActiveBlockObserverCount()).toBe(1);
  });

  it('rebinds a speaker block observer when Meet replaces the text node', async () => {
    const region = mountCaptionsRegion(createCaptionBlock('user1', 'John Doe', 'Hello'));

    await flushMutations();
    const block = region.querySelector('.nMcdL') as HTMLElement;
    const originalText = block.querySelector('.ygicle') as HTMLElement;
    const replacement = document.createElement('div');
    replacement.className = 'ygicle';
    replacement.textContent = 'Hello again';

    originalText.replaceWith(replacement);
    getCollector().scanSpeakerBlock(block);
    await flushMutations();

    replacement.textContent = 'Hello again there';
    await flushMutations();
    expect(getCollector().getActiveBlockObserverCount()).toBe(1);

    jest.advanceTimersByTime(TIMEOUTS.CAPTION_GRACE_MS + 100);
    expect((window as any).getTranscript()).toContain('John Doe : Hello again there');
  });

  it('reports meeting end only after the grace period', async () => {
    const leaveCall = mountLeaveCallControl();
    await flushMutations();
    // The end-detector observer coalesces mutations into one trailing-edge
    // evaluation, so advance the throttle window to register the active state.
    jest.advanceTimersByTime(TIMEOUTS.MEETING_END_OBSERVER_THROTTLE_MS);
    (chrome.runtime.sendMessage as jest.Mock).mockClear();

    leaveCall.remove();
    document.body.appendChild(document.createTextNode('You left the meeting Rejoin'));
    await flushMutations();
    // Let the throttled evaluation fire so the pending end is scheduled.
    jest.advanceTimersByTime(TIMEOUTS.MEETING_END_OBSERVER_THROTTLE_MS);

    jest.advanceTimersByTime(TIMEOUTS.MEETING_END_GRACE_MS - 1);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MEETING_ENDED' })
    );

    jest.advanceTimersByTime(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'MEETING_ENDED',
        reason: 'post-call state detected',
      })
    );
  });

  it('cancels a pending meeting-end report when call controls return', async () => {
    const leaveCall = mountLeaveCallControl();
    await flushMutations();
    jest.advanceTimersByTime(TIMEOUTS.MEETING_END_OBSERVER_THROTTLE_MS);
    (chrome.runtime.sendMessage as jest.Mock).mockClear();

    leaveCall.remove();
    await flushMutations();
    jest.advanceTimersByTime(TIMEOUTS.MEETING_END_OBSERVER_THROTTLE_MS);
    jest.advanceTimersByTime(TIMEOUTS.MEETING_END_GRACE_MS / 2);

    mountLeaveCallControl();
    await flushMutations();
    jest.advanceTimersByTime(TIMEOUTS.MEETING_END_OBSERVER_THROTTLE_MS);
    jest.advanceTimersByTime(TIMEOUTS.MEETING_END_GRACE_MS);

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MEETING_ENDED' })
    );
  });
});
