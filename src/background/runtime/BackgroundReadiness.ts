/** Core MV3 readiness barrier: canonical durable session state must be known before use. */
export class BackgroundReadiness {
  private resolveReady!: () => void;
  private rejectReady!: (reason?: unknown) => void;
  private settled = false;
  private readonly readyPromise: Promise<void>;

  constructor() {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // The entrypoint intentionally exports bootstrap separately; keep a failed
    // readiness barrier from becoming an unhandled rejection before ingress waits.
    void this.readyPromise.catch(() => {});
  }

  wait(): Promise<void> {
    return this.readyPromise;
  }

  markReady(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveReady();
  }

  markFailed(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    const cause = error instanceof Error ? error : new Error(String(error));
    this.rejectReady(new Error(`Background durable state is unavailable: ${cause.message}`));
  }
}
