import type { RecordingHistoryEntry } from '../../../../shared/recordingHistory';

export class MemoryRepository {
  entries = new Map<string, RecordingHistoryEntry>();
  async listPage() {
    return { entries: [...this.entries.values()].filter((entry) => !entry.deletedAt).sort((a, b) => b.createdAt - a.createdAt) };
  }
  async get(id: string) { return this.entries.get(id); }
  async update(id: string, mutate: (entry: RecordingHistoryEntry | undefined) => RecordingHistoryEntry | undefined) {
    const current = this.entries.get(id);
    const next = mutate(current ? structuredClone(current) : undefined);
    if (next) this.entries.set(id, structuredClone(next));
    return next;
  }
}
