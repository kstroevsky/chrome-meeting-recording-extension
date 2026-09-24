import type {
  RecordingContext,
  RecordingSourceContext,
} from '../../../shared/recordingContext';
import type { RecordingContextRepositoryPort } from './RecordingContextRepository';

export class RecordingContextService {
  constructor(private readonly repository: RecordingContextRepositoryPort) {}

  get(recordingId: string): Promise<RecordingContext | undefined> {
    return this.repository.get(recordingId);
  }

  async begin(
    recordingId: string,
    startedAt: number,
    source: RecordingSourceContext,
  ): Promise<void> {
    await this.repository.put({ recordingId, startedAt, source });
  }

  finish(recordingId: string, endedAt: number): Promise<RecordingContext | undefined> {
    return this.repository.finish(recordingId, endedAt);
  }

  remove(recordingId: string): Promise<void> {
    return this.repository.remove(recordingId);
  }
}
