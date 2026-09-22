import type { AnalysisJob } from '../../shared/analysis/job';
import { ANALYSIS_E2E_GATE_CHANNEL } from '../../shared/e2e';

type WaitingAnalysis = {
  jobId: string;
  release: () => void;
};

/**
 * Deterministic E2E-only pause point immediately before analysis opens its
 * embedding engine. The control page talks to the offscreen document directly
 * over BroadcastChannel, so killing the MV3 service worker cannot destroy the
 * synchronization mechanism used to test that kill.
 */
export class AnalysisE2EGate {
  private readonly channel = new BroadcastChannel(ANALYSIS_E2E_GATE_CHANNEL);
  private armed = false;
  private waiting: WaitingAnalysis | null = null;

  constructor() {
    this.channel.onmessage = (event) => {
      const message = event.data as { type?: unknown } | null;
      if (!message || typeof message !== 'object') return;

      if (message.type === 'arm') {
        this.armed = true;
        this.channel.postMessage({ type: 'armed' });
        return;
      }

      if (message.type === 'release') {
        this.armed = false;
        const waiting = this.waiting;
        this.waiting = null;
        waiting?.release();
        this.channel.postMessage({ type: 'released', jobId: waiting?.jobId });
      }
    };
  }

  wait = (job: AnalysisJob): Promise<void> => {
    if (!this.armed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiting = { jobId: job.id, release: resolve };
      this.channel.postMessage({ type: 'paused', jobId: job.id });
    });
  };
}
