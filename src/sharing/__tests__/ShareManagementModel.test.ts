import { managedShares } from '../ShareManagementModel';
import type { ShareRuntimeSnapshot } from '../ShareRuntime';

describe('ShareManagementModel', () => {
  it('renders a server-only share from registry summary metadata', () => {
    const snapshot: ShareRuntimeSnapshot = {
      remote: [{
        id: 'remote-only',
        status: 'active',
        recordingTitles: ['Customer call'],
        recordingCount: 1,
        trackCount: 2,
        totalBytes: 42,
        createdAt: 10,
        updatedAt: 20,
        finalizedAt: 20,
        shareUrl: 'https://share.example/s/capability',
      }],
      local: [],
      uploads: [],
      refreshedAt: 30,
    };

    expect(managedShares(snapshot)).toEqual([
      expect.objectContaining({
        id: 'remote-only',
        recordingTitles: ['Customer call'],
        trackCount: 2,
        totalBytes: 42,
        status: 'active',
        shareUrl: 'https://share.example/s/capability',
        tracks: [],
      }),
    ]);
  });
});
