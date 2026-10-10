/**
 * Runs work for a key at most once at a time, folding requests that arrive
 * while it runs into one more run afterwards.
 *
 * Recording changes arrive in bursts: every whole percent of an upload
 * notifies twice, and captions notify on every batch. Each consideration reads
 * the recording's current state, so the runs a burst would queue behind the
 * first all see the same thing; one rerun after it sees everything they would
 * have. No request is dropped: every caller's promise settles after a run that
 * started after its request.
 */
export class KeyedCoalescer {
  private readonly runs = new Map<string, { again: boolean; done: Promise<void> }>();

  constructor(private readonly work: (key: string) => Promise<void>) {}

  request(key: string): Promise<void> {
    const running = this.runs.get(key);
    if (running) {
      running.again = true;
      return running.done;
    }
    // Registered before the first run starts, so a request made from inside
    // the work folds into this entry instead of starting a parallel run.
    const entry = { again: false, done: Promise.resolve() };
    this.runs.set(key, entry);
    entry.done = this.drain(key, entry);
    return entry.done;
  }

  /** A failed run still honours requests made during it; the result is the last run's. */
  private async drain(key: string, entry: { again: boolean }): Promise<void> {
    await Promise.resolve();
    let failure: { error: unknown } | undefined;
    try {
      do {
        entry.again = false;
        failure = undefined;
        try {
          await this.work(key);
        } catch (error) {
          failure = { error };
        }
      } while (entry.again);
    } finally {
      this.runs.delete(key);
    }
    if (failure) throw failure.error;
  }
}
