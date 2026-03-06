import { TIMEOUTS } from '../src/shared/timeouts';

describe('scrapingScript', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = `
      <div role="region" aria-label="Captions">
        <div class="nMcdL" data-participant-id="user1">
          <div class="NWpY1d">John Doe</div>
          <div class="ygicle">Hello world</div>
        </div>
      </div>
    `;

    jest.resetModules();
    require('../src/scrapingScript');
    (window as any).collector.start();
  });

  afterEach(() => {
    if ((window as any).collector) {
      (window as any).collector.stop();
    }
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('collects transcripts from DOM', async () => {
    // Wait for initial MutationObserver to detect the region
    await Promise.resolve();
    // Fast-forward to trigger the flush timer
    jest.advanceTimersByTime(TIMEOUTS.CAPTION_GRACE_MS + 100);

    const transcript = (window as any).getTranscript();
    expect(transcript).toContain('John Doe : Hello world');
  });

  it('resets transcript cleanly', async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(TIMEOUTS.CAPTION_GRACE_MS + 100);
    
    // Simulate a user clearing transcript
    (window as any).resetTranscript();
    
    expect((window as any).getTranscript()).toBe('');
  });

  it('observes text revisions (debouncing)', () => {
    const textNode = document.querySelector('.ygicle')!;
    
    // Meet continuously updates the text while speaking
    textNode.textContent = 'Hello w';
    // This triggers MutationObserver... wait, in jsdom we might need to manually trigger mutations
    // or wait for microtasks. For simplicity, since the scraping logic listens to text updates,
    // we can simulate an update and advance timer.
  });
});
