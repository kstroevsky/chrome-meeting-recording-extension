import type { AnalysisJob } from '../../../shared/analysis/job';
import { wireAnalysisRuntime } from '../AnalysisRuntime';

const JOB: AnalysisJob = {
  id: 'job-1',
  historyId: 'recording-1',
  status: 'analyzing',
  progress: 0.5,
  startedAt: 1,
};

describe('wireAnalysisRuntime', () => {
  it('keeps cross-feature analysis wiring in runtime and resynchronizes critical work', async () => {
    const offscreen: any = {};
    const analysisCoordinator = {
      handleJobState: jest.fn(),
      handleResult: jest.fn().mockResolvedValue(undefined),
    };
    const criticalWork = {
      markAnalysisWorkKnown: jest.fn(),
      sync: jest.fn(),
    };
    const logger = { warn: jest.fn() };

    wireAnalysisRuntime({
      offscreen,
      analysisCoordinator: analysisCoordinator as never,
      criticalWork: criticalWork as never,
      logger,
    });

    offscreen.onAnalysisJobChanged(JOB);
    expect(criticalWork.markAnalysisWorkKnown).toHaveBeenCalledTimes(1);
    expect(analysisCoordinator.handleJobState).toHaveBeenCalledWith(JOB);
    expect(criticalWork.sync).toHaveBeenCalledTimes(1);

    offscreen.onAnalysisResult(JOB, { result: true }, { provenance: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(analysisCoordinator.handleResult).toHaveBeenCalledWith(
      JOB,
      { result: true },
      { provenance: true },
    );
    expect(criticalWork.sync).toHaveBeenCalledTimes(2);
  });

  it('still resynchronizes critical work when result handling fails', async () => {
    const offscreen: any = {};
    const failure = new Error('storage failed');
    const analysisCoordinator = {
      handleJobState: jest.fn(),
      handleResult: jest.fn().mockRejectedValue(failure),
    };
    const criticalWork = { markAnalysisWorkKnown: jest.fn(), sync: jest.fn() };
    const logger = { warn: jest.fn() };

    wireAnalysisRuntime({
      offscreen,
      analysisCoordinator: analysisCoordinator as never,
      criticalWork: criticalWork as never,
      logger,
    });

    offscreen.onAnalysisResult(JOB, {}, undefined);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.warn).toHaveBeenCalledWith(
      'Could not handle an analysis result',
      'recording-1',
      failure,
    );
    expect(criticalWork.sync).toHaveBeenCalledTimes(1);
  });
});
