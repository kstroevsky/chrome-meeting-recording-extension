import type { RecordingHistoryEntry } from '../../../shared/recordingHistory';
import { countExternalPlaybackRecordings } from '../integrationRuntimeQueries';

function recording(index: number, destinationId?: string, deleted = false): RecordingHistoryEntry {
  return {
    id: `recording-${index}`,
    name: `Recording ${index}`,
    createdAt: index + 1,
    storageMode: 'local',
    status: 'complete',
    files: [{
      id: `recording-${index}:tab`,
      stream: 'tab',
      filename: 'tab.webm',
      mimeType: 'video/webm',
      locations: destinationId
        ? [{ kind: 'external', destinationId, artifactId: `media-${index}` }]
        : [{ kind: 'download', downloadId: index + 1 }],
      delivery: { requested: 'local', status: 'downloaded' },
      destination: 'local',
      status: 'available',
    }],
    ...(deleted ? { deletedAt: 10_000 + index } : {}),
  };
}

describe('integration disconnect impact', () => {
  it('counts unique live owners across libraries larger than the 50-row UI page', () => {
    const rows = Array.from({ length: 80 }, (_, index) => (
      recording(index, index < 67 ? 'crm' : index < 75 ? 'other' : undefined, index === 12)
    ));
    // Multiple artifacts at the same destination still count as one recording.
    rows[20].files.push({
      ...rows[20].files[0],
      id: 'recording-20:mic',
      stream: 'mic',
      filename: 'mic.webm',
    });

    expect(countExternalPlaybackRecordings(rows, 'crm')).toBe(66);
    expect(countExternalPlaybackRecordings(rows, 'other')).toBe(8);
  });
});
