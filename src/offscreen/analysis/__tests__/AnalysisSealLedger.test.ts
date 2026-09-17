import { AnalysisSealLedger } from '../AnalysisSealLedger';
import { AnalysisJobStateOutbox, SEAL_ATTEMPTS } from '../AnalysisJobStateOutbox';
import type { AnalysisJob } from '../../../shared/analysis/job';

const JOB: AnalysisJob = {
  id: 'ana_1',
  historyId: 'rec_1',
  status: 'completed',
  progress: 1,
  topicCount: 2,
  segmentCount: 3,
  startedAt: 1_000,
  finishedAt: 9_000,
};

/** An outbox whose store can be made to fail, counting what it was asked. */
function outbox(options: { putFails?: boolean; removeFails?: boolean } = {}) {
  const calls = { put: 0, remove: 0 };
  const area = {
    getAll: async () => ({}),
    set: async () => {
      calls.put += 1;
      if (options.putFails) throw new Error('disk I/O error');
    },
    remove: async () => {
      calls.remove += 1;
      if (options.removeFails) throw new Error('disk I/O error');
    },
  };
  return { calls, outbox: new AnalysisJobStateOutbox(area) };
}

/** Stands in for `AnalysisManager`'s hold on a completed result. */
function heldResults() {
  const released: string[] = [];
  return { released, held: { acknowledge: (jobId: string) => { released.push(jobId); } } };
}

/** No real waiting between attempts. */
const delay = async () => {};

/**
 * The whole completion flow as the offscreen document runs it: report the
 * terminal state, deliver the result, then apply background's acknowledgement.
 */
async function runCompletion(ledger: AnalysisSealLedger) {
  const delivered: string[] = [];
  await ledger.ensureSealed(JOB);                       // reportAnalysisJob
  await ledger.deliver(JOB, () => delivered.push(JOB.id)); // deliverAnalysisResult
  return delivered;
}

describe('AnalysisSealLedger', () => {
  it('seals once for the whole flow, not once per caller', async () => {
    // Reporting and delivering both need the state on disk. Before this was a
    // single outcome, each ran its own bounded retry — three attempts became
    // six, and "three attempts" was true of the helper but not of the flow.
    const { calls, outbox: box } = outbox({ putFails: true, removeFails: true });
    const { held } = heldResults();
    const ledger = new AnalysisSealLedger(box, held, { delay });

    await runCompletion(ledger);

    expect(calls.put).toBe(SEAL_ATTEMPTS);
  });

  it('delivers an unsealed result and then releases it on acknowledgement', async () => {
    // The liveness the degraded path exists for: with the store permanently
    // broken, the result still reaches background *and* stops being held —
    // otherwise the document stays busy forever and blocks every update.
    const { calls, outbox: box } = outbox({ putFails: true, removeFails: true });
    const { released, held } = heldResults();
    const ledger = new AnalysisSealLedger(box, held, { delay });

    const delivered = await runCompletion(ledger);
    expect(delivered).toEqual([JOB.id]);

    await expect(ledger.acknowledge(JOB.id)).resolves.toBe(true);
    expect(released).toEqual([JOB.id]);
    // There was never a row, so the broken store is not even asked.
    expect(calls.remove).toBe(0);
  });

  it('takes the durable path when the state was sealed', async () => {
    const { calls, outbox: box } = outbox();
    const { released, held } = heldResults();
    const ledger = new AnalysisSealLedger(box, held, { delay });

    await runCompletion(ledger);
    expect(calls.put).toBe(1);

    await expect(ledger.acknowledge(JOB.id)).resolves.toBe(true);
    // Row first, then the payload.
    expect(calls.remove).toBe(1);
    expect(released).toEqual([JOB.id]);
  });

  it('keeps a sealed job held when its row cannot be removed', async () => {
    // Unlike the unsealed case, a row that exists and will not go away means
    // the result must survive with it, so a reconnect can try again.
    const { outbox: box } = outbox({ removeFails: true });
    const { released, held } = heldResults();
    const ledger = new AnalysisSealLedger(box, held, { delay });

    await runCompletion(ledger);
    await expect(ledger.acknowledge(JOB.id)).resolves.toBe(false);
    expect(released).toEqual([]);
  });

  it('takes the durable path for a job replayed after a restart', async () => {
    // No sealing outcome recorded here, but the row on disk is real.
    const { calls, outbox: box } = outbox();
    const { released, held } = heldResults();
    const ledger = new AnalysisSealLedger(box, held, { delay });

    await expect(ledger.acknowledge('ana_replayed')).resolves.toBe(true);
    expect(calls.remove).toBe(1);
    expect(released).toEqual(['ana_replayed']);
  });

  it('shares one attempt between concurrent callers', async () => {
    const { calls, outbox: box } = outbox();
    const { held } = heldResults();
    const ledger = new AnalysisSealLedger(box, held, { delay });

    await Promise.all([ledger.ensureSealed(JOB), ledger.ensureSealed(JOB), ledger.deliver(JOB, () => {})]);
    expect(calls.put).toBe(1);
  });

  it('warns when it delivers without durability, and not when it does not', async () => {
    const broken = outbox({ putFails: true });
    const warn = jest.fn();
    await new AnalysisSealLedger(broken.outbox, heldResults().held, { delay, warn }).deliver(JOB, () => {});
    expect(warn.mock.calls.some(([m]) => String(m).includes('without a durable terminal state'))).toBe(true);

    const healthy = outbox();
    const quiet = jest.fn();
    await new AnalysisSealLedger(healthy.outbox, heldResults().held, { delay, warn: quiet }).deliver(JOB, () => {});
    expect(quiet.mock.calls.some(([m]) => String(m).includes('without a durable terminal state'))).toBe(false);
  });
});
