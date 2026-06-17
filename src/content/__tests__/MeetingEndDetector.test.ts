import { MeetingEndDetector } from '../MeetingEndDetector';
import { TIMEOUTS } from '../../shared/timeouts';
import type {
  MeetingLifecycleState,
  MeetingProviderAdapter,
} from '../MeetingProviderAdapter';

/** Minimal provider stub — the detector only ever calls getMeetingLifecycleState. */
function makeProvider(state: () => MeetingLifecycleState): MeetingProviderAdapter {
  return {
    getMeetingLifecycleState: jest.fn(state),
  } as unknown as MeetingProviderAdapter;
}

function makeDetector(provider: MeetingProviderAdapter) {
  const onMeetingEnded = jest.fn();
  const detector = new MeetingEndDetector({
    provider,
    getMeetingId: () => 'meeting-1',
    onMeetingEnded,
  });
  return { detector, onMeetingEnded };
}

async function flushMutations(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('MeetingEndDetector observer coalescing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('coalesces a burst of DOM mutations into a single throttled evaluation', async () => {
    const provider = makeProvider(() => 'active');
    const { detector } = makeDetector(provider);

    detector.start(); // one immediate evaluate() during start
    (provider.getMeetingLifecycleState as jest.Mock).mockClear();

    // A burst of structural mutations, each flushed so the observer fires per node.
    for (let i = 0; i < 10; i++) {
      document.body.appendChild(document.createElement('div'));
      await flushMutations();
    }

    // Trailing-edge throttle: nothing has been evaluated yet.
    expect(provider.getMeetingLifecycleState).not.toHaveBeenCalled();

    jest.advanceTimersByTime(TIMEOUTS.MEETING_END_OBSERVER_THROTTLE_MS);

    // 10 mutations collapse to exactly one evaluation.
    expect(provider.getMeetingLifecycleState).toHaveBeenCalledTimes(1);

    detector.stop();
  });

  it('does not evaluate on characterData-only mutations', async () => {
    const text = document.createTextNode('hello');
    document.body.appendChild(text);

    const provider = makeProvider(() => 'active');
    const { detector } = makeDetector(provider);

    detector.start();
    (provider.getMeetingLifecycleState as jest.Mock).mockClear();

    // Pure text change — must not wake the observer now that characterData is dropped.
    text.data = 'hello world';
    await flushMutations();
    jest.advanceTimersByTime(TIMEOUTS.MEETING_END_OBSERVER_THROTTLE_MS + 10);

    expect(provider.getMeetingLifecycleState).not.toHaveBeenCalled();

    detector.stop();
  });

  it('stops the pending throttled evaluation when stopped mid-window', async () => {
    const provider = makeProvider(() => 'active');
    const { detector } = makeDetector(provider);

    detector.start();
    (provider.getMeetingLifecycleState as jest.Mock).mockClear();

    document.body.appendChild(document.createElement('div'));
    await flushMutations();
    detector.stop(); // clears the throttle timer before it fires

    jest.advanceTimersByTime(TIMEOUTS.MEETING_END_OBSERVER_THROTTLE_MS + 10);
    expect(provider.getMeetingLifecycleState).not.toHaveBeenCalled();
  });
});
