/** ADR-0006 §21: the tab track is the clock; everything else follows it. */
import { PlaybackClock, type ClockElement } from '../PlaybackClock';

function element(currentTime = 0): ClockElement & { plays: number; pauses: number } {
  return {
    currentTime,
    playbackRate: 1,
    paused: true,
    plays: 0,
    pauses: 0,
    async play() { this.plays += 1; this.paused = false; },
    pause() { this.pauses += 1; this.paused = true; },
  };
}

describe('PlaybackClock', () => {
  it('aligns an auxiliary the moment it is added', () => {
    const master = element(10);
    const aux = element(0);
    new PlaybackClock(master).add({ element: aux, timelineOffsetMs: 0 });
    expect(aux.currentTime).toBe(10);
  });

  it('applies a signed offset — a track that started early sits ahead', () => {
    const master = element(10);
    const early = element();
    const late = element();
    const clock = new PlaybackClock(master);

    // Negative offset: this track's first sample predates the master's.
    clock.add({ element: early, timelineOffsetMs: -250 });
    clock.add({ element: late, timelineOffsetMs: 400 });

    expect(early.currentTime).toBeCloseTo(10.25);
    expect(late.currentTime).toBeCloseTo(9.6);
  });

  it('never seeks an auxiliary before its own start', () => {
    const master = element(0.1);
    const aux = element();
    new PlaybackClock(master).add({ element: aux, timelineOffsetMs: 5_000 });
    expect(aux.currentTime).toBe(0);
  });

  it('starts every track together, aligning first', async () => {
    const master = element(30);
    const aux = element(2);
    const clock = new PlaybackClock(master);
    clock.add({ element: aux, timelineOffsetMs: 0 });
    aux.currentTime = 2; // drifted while paused

    await clock.play();

    expect(aux.currentTime).toBe(30);
    expect(master.plays).toBe(1);
    expect(aux.plays).toBe(1);
  });

  it('pauses and seeks everything as one', () => {
    const master = element();
    const aux = element();
    const clock = new PlaybackClock(master);
    clock.add({ element: aux, timelineOffsetMs: 1_000 });

    clock.seek(60_000);
    expect(master.currentTime).toBe(60);
    expect(aux.currentTime).toBe(59);

    clock.pause();
    expect(master.pauses).toBe(1);
    expect(aux.pauses).toBe(1);
  });

  it('propagates playback rate', () => {
    const master = element();
    const aux = element();
    const clock = new PlaybackClock(master);
    clock.add({ element: aux, timelineOffsetMs: 0 });

    clock.setPlaybackRate(1.5);
    expect(master.playbackRate).toBe(1.5);
    expect(aux.playbackRate).toBe(1.5);
  });

  describe('drift correction', () => {
    const drifted = (byMs: number) => {
      const master = element(10);
      const aux = element(10 + byMs / 1000);
      const onDrift = jest.fn();
      const clock = new PlaybackClock(master, { onDrift });
      clock.add({ element: aux, timelineOffsetMs: 0 });
      aux.currentTime = 10 + byMs / 1000; // add() aligned it; re-introduce the drift
      return { clock, aux, onDrift };
    };

    it('leaves a small error alone — a seek would be more audible than the drift', () => {
      const { clock, aux, onDrift } = drifted(20);
      expect(clock.correctDrift()).toBe(0);
      expect(aux.currentTime).toBeCloseTo(10.02);
      expect(onDrift).not.toHaveBeenCalled();
    });

    it('watches the middle band without seeking', () => {
      const { clock, aux, onDrift } = drifted(90);
      expect(clock.correctDrift()).toBe(0);
      expect(aux.currentTime).toBeCloseTo(10.09);
      expect(onDrift).toHaveBeenCalledWith(expect.closeTo(0.09, 3));
    });

    it('hard-resyncs once the tracks are audibly apart', () => {
      const { clock, aux } = drifted(400);
      expect(clock.correctDrift()).toBe(1);
      expect(aux.currentTime).toBe(10);
    });

    it('corrects a track that has fallen behind as well as one that ran ahead', () => {
      const { clock, aux } = drifted(-400);
      expect(clock.correctDrift()).toBe(1);
      expect(aux.currentTime).toBe(10);
    });

    it('is a no-op with no auxiliaries', () => {
      expect(new PlaybackClock(element()).correctDrift()).toBe(0);
    });

    it('stops following a track once cleared', () => {
      const master = element(10);
      const aux = element(99);
      const clock = new PlaybackClock(master);
      clock.add({ element: aux, timelineOffsetMs: 0 });
      clock.clear();
      aux.currentTime = 99;

      expect(clock.correctDrift()).toBe(0);
      expect(aux.currentTime).toBe(99);
    });
  });
});
