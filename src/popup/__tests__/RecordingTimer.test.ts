import { RecordingTimer } from '../RecordingTimer';
import { formatDuration } from '../popupStatus';
import type { RecordingStatusView } from '../../shared/recording';

const session = (over: Partial<RecordingStatusView>): RecordingStatusView => over as RecordingStatusView;

describe('RecordingTimer', () => {
  let el: HTMLElement;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    el = document.createElement('span');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('renders banked + live elapsed and ticks once per second while recording', () => {
    const timer = new RecordingTimer(el);
    // 5s already banked, live span started "now" (system time 10_000).
    timer.sync('recording', session({ recordedMs: 5_000, runningSince: 10_000, paused: false }));
    expect(el.textContent).toBe(formatDuration(5_000));

    jest.advanceTimersByTime(1_000);
    expect(el.textContent).toBe(formatDuration(6_000));

    jest.advanceTimersByTime(2_000);
    expect(el.textContent).toBe(formatDuration(8_000));
  });

  it('shows only the banked time and does not tick while paused', () => {
    const timer = new RecordingTimer(el);
    timer.sync('recording', session({ recordedMs: 7_000, runningSince: 10_000, paused: true }));
    expect(el.textContent).toBe(formatDuration(7_000));

    jest.advanceTimersByTime(5_000);
    expect(el.textContent).toBe(formatDuration(7_000)); // frozen — no live span
  });

  it('does not run a live span outside the recording phase', () => {
    const timer = new RecordingTimer(el);
    timer.sync('stopping', session({ recordedMs: 3_000, runningSince: 10_000, paused: false }));
    expect(el.textContent).toBe(formatDuration(3_000));

    jest.advanceTimersByTime(5_000);
    expect(el.textContent).toBe(formatDuration(3_000));
  });

  it('stops ticking after stop() and is idempotent', () => {
    const timer = new RecordingTimer(el);
    timer.sync('recording', session({ recordedMs: 0, runningSince: 10_000, paused: false }));
    jest.advanceTimersByTime(1_000);
    expect(el.textContent).toBe(formatDuration(1_000));

    timer.stop();
    timer.stop(); // idempotent — must not throw or re-arm
    jest.advanceTimersByTime(5_000);
    expect(el.textContent).toBe(formatDuration(1_000)); // frozen after stop
  });

  it('tolerates a missing element', () => {
    const timer = new RecordingTimer(null);
    expect(() =>
      timer.sync('recording', session({ recordedMs: 1_000, runningSince: 10_000, paused: false })),
    ).not.toThrow();
    expect(() => jest.advanceTimersByTime(2_000)).not.toThrow();
  });
});
