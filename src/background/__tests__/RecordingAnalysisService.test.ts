import { RecordingAnalysisService } from '../RecordingAnalysisService';
import type { RecordingAnalysisRepositoryPort } from '../RecordingAnalysisRepository';
import { PIPELINE_VERSION, type AnalysisProvenance } from '../../shared/analysis/provenance';
import { normalizeStoredAnalysis, type StoredAnalysis } from '../../shared/analysis/storedAnalysis';

const provenance = (over: Partial<AnalysisProvenance> = {}): AnalysisProvenance => ({
  pipelineVersion: PIPELINE_VERSION,
  embeddingModel: 'Xenova/multilingual-e5-small',
  embeddingModelRevision: '761b726d',
  embeddingDimensions: 384,
  embeddingDtype: 'q8',
  configHash: 'abc12345',
  ...over,
});

const v = (...values: number[]) => Float32Array.from(values);

const result = () => ({
  segments: [
    { id: 'segment:1', tStartMs: 0, tEndMs: 10_000, embedding: v(1, 0), localTopicId: 'topic:1', startWindow: 0, endWindow: 3 },
    { id: 'segment:2', tStartMs: 20_000, tEndMs: 30_000, embedding: v(0, 1), localTopicId: 'topic:2', startWindow: 3, endWindow: 6 },
  ],
  topics: [
    { id: 'topic:1', centroid: v(1, 0), segments: ['segment:1'], keywords: ['redis', 'pool'], importance: 0.8 },
    { id: 'topic:2', centroid: v(0, 1), segments: ['segment:2'], keywords: ['berlin'], importance: 0.4 },
  ],
  utteranceCount: 40,
});

function fakeRepository() {
  const rows = new Map<string, StoredAnalysis>();
  const port: RecordingAnalysisRepositoryPort & { rows: Map<string, StoredAnalysis> } = {
    rows,
    async get(id) { return rows.get(id); },
    async put(id, analysis) {
      const checked = normalizeStoredAnalysis(analysis);
      if (!checked) throw new Error('Refusing to store an analysis that does not decode');
      rows.set(id, checked);
    },
    async remove(id) { rows.delete(id); },
  };
  return port;
}

describe('RecordingAnalysisService', () => {
  it('stamps a saved analysis with the conditions it ran under', async () => {
    const repository = fakeRepository();
    const service = new RecordingAnalysisService(repository, () => provenance());

    const saved = await service.save('rec:1', result(), 1_700_000);
    expect(saved.provenance).toEqual(provenance());
    expect(saved.completedAt).toBe(1_700_000);
  });

  it('does not let a job record conditions it did not use', async () => {
    const service = new RecordingAnalysisService(fakeRepository(), () => provenance({ embeddingDtype: 'q8' }));
    // The caller cannot supply provenance at all — the signature omits it, and
    // the service applies its own.
    const saved = await service.save('rec:1', result());
    expect(saved.provenance.embeddingDtype).toBe('q8');
  });

  it('reads back an analysis computed under the same conditions', async () => {
    const service = new RecordingAnalysisService(fakeRepository(), () => provenance());
    await service.save('rec:1', result());

    const stored = await service.get('rec:1');
    expect(stored?.topics).toHaveLength(2);
    expect(stored?.segments).toHaveLength(2);
  });

  it('hides an analysis whose conditions no longer apply', async () => {
    const repository = fakeRepository();
    let dtype: AnalysisProvenance['embeddingDtype'] = 'q8';
    const service = new RecordingAnalysisService(repository, () => provenance({ embeddingDtype: dtype }));
    await service.save('rec:1', result());

    // The packaged model is re-quantized: the vectors move, so the topics
    // derived from them are no longer the ones this pipeline would produce.
    dtype = 'fp16';
    expect(await service.get('rec:1')).toBeUndefined();
    // The row is still there, though — recomputing replaces it, reading does not.
    expect(repository.rows.has('rec:1')).toBe(true);
  });

  it('distinguishes never-analysed from analysed-and-stale', async () => {
    let version = PIPELINE_VERSION;
    const service = new RecordingAnalysisService(fakeRepository(), () => provenance({ pipelineVersion: version }));

    await expect(service.state('rec:1')).resolves.toEqual({ status: 'none' });

    await service.save('rec:1', result());
    await expect(service.state('rec:1')).resolves.toMatchObject({ status: 'ready' });

    // A provisional scoring term gets redefined: no config value moves, so only
    // the pipeline version can mark the old result stale.
    version = PIPELINE_VERSION + 1;
    await expect(service.state('rec:1')).resolves.toEqual({ status: 'stale' });
  });

  it('summarizes for a list surface without carrying the vectors', async () => {
    const service = new RecordingAnalysisService(fakeRepository(), () => provenance());
    await service.save('rec:1', result());

    const state = await service.state('rec:1');
    expect(state).toEqual({
      status: 'ready',
      summary: {
        topicCount: 2,
        segmentCount: 2,
        completedAt: expect.any(Number),
        // Strongest topic first, so a row can render the label that matters.
        labels: [['redis', 'pool'], ['berlin']],
      },
    });
    expect(JSON.stringify(state)).not.toContain('centroid');
  });

  it('refuses a result whose segments name a topic that does not exist', async () => {
    const service = new RecordingAnalysisService(fakeRepository(), () => provenance());
    const incoherent = { ...result(), topics: [result().topics[0]] };

    await expect(service.save('rec:1', incoherent)).rejects.toThrow(/does not decode/);
  });

  it('drops an analysis entirely', async () => {
    const repository = fakeRepository();
    const service = new RecordingAnalysisService(repository, () => provenance());
    await service.save('rec:1', result());

    await service.removeAll('rec:1');
    expect(repository.rows.has('rec:1')).toBe(false);
    await expect(service.state('rec:1')).resolves.toEqual({ status: 'none' });
  });

  describe('topicSummaries', () => {
    it('digests a page of recordings into keywords and a search haystack', async () => {
      const repository = fakeRepository();
      const service = new RecordingAnalysisService(repository, () => provenance());
      await service.save('rec:1', result(), 1);

      const summaries = await service.topicSummaries(['rec:1', 'rec:2']);

      expect(summaries['rec:1']).toEqual({
        // Across topics, strongest first — what the call covered, not its best topic.
        keywords: ['redis', 'pool', 'berlin'],
        search: 'redis pool berlin',
        topicCount: 2,
      });
      // A recording with no analysis is absent, not present and empty.
      expect('rec:2' in summaries).toBe(false);
    });

    it('omits a recording whose analysis no longer matches the current conditions', async () => {
      const repository = fakeRepository();
      let current = provenance();
      const service = new RecordingAnalysisService(repository, () => current);
      await service.save('rec:1', result(), 1);

      expect(await service.topicSummaries(['rec:1'])).toHaveProperty('rec:1');
      current = provenance({ configHash: 'deadbeef' });
      expect(await service.topicSummaries(['rec:1'])).toEqual({});
    });

    it('answers nothing for an empty page', async () => {
      const service = new RecordingAnalysisService(fakeRepository(), () => provenance());
      expect(await service.topicSummaries([])).toEqual({});
    });
  });
});