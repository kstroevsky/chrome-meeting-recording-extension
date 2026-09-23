jest.mock('../../../platform/chrome/runtime', () => ({
  pokeRuntime: jest.fn(),
}));

import { pokeRuntime } from '../../../platform/chrome/runtime';
import {
  isFreshRecordingStart,
  startKeepAlive,
  stopKeepAlive,
} from '../KeepAlive';

describe('isFreshRecordingStart', () => {
  it('is true when entering a busy phase from a non-busy one', () => {
    expect(isFreshRecordingStart('idle', 'starting')).toBe(true);
    expect(isFreshRecordingStart('failed', 'starting')).toBe(true);
  });

  it('is false for busy-to-busy transitions within a run', () => {
    expect(isFreshRecordingStart('starting', 'recording')).toBe(false);
    expect(isFreshRecordingStart('recording', 'stopping')).toBe(false);
  });

  it('is false when a run finishes', () => {
    expect(isFreshRecordingStart('stopping', 'idle')).toBe(false);
    expect(isFreshRecordingStart('recording', 'idle')).toBe(false);
  });

  it('is false for idle-to-idle', () => {
    expect(isFreshRecordingStart('idle', 'idle')).toBe(false);
  });
});

describe('keep-alive loop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopKeepAlive();
    jest.useRealTimers();
  });

  it('pokes the runtime on an interval and is idempotent', () => {
    startKeepAlive();
    startKeepAlive();

    jest.advanceTimersByTime(20_000);
    expect(pokeRuntime).toHaveBeenCalledTimes(1);
  });

  it('stops poking after stopKeepAlive', () => {
    startKeepAlive();
    jest.advanceTimersByTime(20_000);
    stopKeepAlive();
    jest.advanceTimersByTime(60_000);
    expect(pokeRuntime).toHaveBeenCalledTimes(1);
  });
});
