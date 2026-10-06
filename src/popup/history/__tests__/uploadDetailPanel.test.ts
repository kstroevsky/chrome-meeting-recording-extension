import { renderUploadDetail } from '../uploadDetailPanel';
import type { UploadJob } from '../../../shared/recording';

describe('renderUploadDetail', () => {
  it('counts a file Drive has all of as landed, before the job settles its status', () => {
    const content = document.createElement('div');
    const job: UploadJob = {
      id: 'job-1',
      label: 'Weekly review',
      status: 'uploading',
      progress: 0.04,
      startedAt: 0,
      files: [
        { stream: 'mic', filename: 'mic.webm', status: 'uploading', bytes: 100, uploadedBytes: 100 },
        { stream: 'tab', filename: 'tab.webm', status: 'uploading', bytes: 100, uploadedBytes: 5 },
        { stream: 'self-video', filename: 'camera.webm', status: 'uploading', bytes: 100 },
      ],
    };

    renderUploadDetail(content, job, () => {});

    expect(content.querySelector('.recording-detail-meta')!.textContent).toMatch(/^1 OF 3 FILES · 4% · /);
    const states = Array.from(content.querySelectorAll('.up-file-state')).map((s) => s.textContent);
    expect(states).toEqual(['SAVED', 'UPLOADING 5%', 'QUEUED']);
  });
});
