import type {
  RecordingContext,
  RecordingSourceContext,
} from '../../../shared/recordingContext';
import type {
  RecordingDestinationMediaTarget,
  RecordingDestinationRoute,
} from '../../../shared/recordingDestinations';
import type { RecordingContextRepositoryPort } from './RecordingContextRepository';

export class RecordingContextService {
  constructor(
    private readonly repository: RecordingContextRepositoryPort,
    private readonly onChanged?: (recordingId: string) => void,
  ) {}

  get(recordingId: string): Promise<RecordingContext | undefined> {
    return this.repository.get(recordingId);
  }

  async begin(
    recordingId: string,
    startedAt: number,
    source: RecordingSourceContext,
    destinationProfileId?: string,
    destinationMediaTarget?: Extract<RecordingDestinationMediaTarget, { kind: 'local' | 'drive' }>,
    destinationRoutes?: readonly RecordingDestinationRoute[],
  ): Promise<void> {
    await this.repository.put({
      recordingId,
      startedAt,
      source,
      ...(destinationProfileId ? { destinationProfileId } : {}),
      ...(destinationMediaTarget ? { destinationMediaTarget: { ...destinationMediaTarget } } : {}),
      ...(destinationRoutes ? { destinationRoutes: destinationRoutes.map((route) => ({ ...route })) } : {}),
    });
  }

  async finish(recordingId: string, endedAt: number): Promise<RecordingContext | undefined> {
    const result = await this.repository.finish(recordingId, endedAt);
    if (result) this.onChanged?.(recordingId);
    return result;
  }

  remove(recordingId: string): Promise<void> {
    return this.repository.remove(recordingId);
  }
}
