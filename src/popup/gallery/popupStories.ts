/** Development-only deterministic inputs for the real popup preview renderer. */

import type {
  PopupPreviewShellState,
  PopupPreviewState,
} from '../popupPreviewState';
import type { RecordingStatusView, UploadJob } from '../../shared/recording';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';

export type PopupStoryGroup = 'Setup' | 'Permissions' | 'Recording' | 'Saving' | 'Library' | 'Overlays';

export type PopupStory = {
  id: string;
  title: string;
  group: PopupStoryGroup;
  description: string;
  preview: PopupPreviewState;
  shell?: PopupPreviewShellState;
};

const FIXTURE_TIME = Date.UTC(2026, 6, 26, 12, 0, 0);

const runConfig = {
  storageMode: 'drive' as const,
  micMode: 'separate' as const,
  recordSelfVideo: true,
  tabContentType: 'screen' as const,
};

function session(overrides: Partial<RecordingStatusView> = {}): RecordingStatusView {
  return {
    phase: 'idle',
    runConfig,
    updatedAt: FIXTURE_TIME,
    ...overrides,
  };
}

function uploadJob(status: UploadJob['status'] = 'uploading', progress = 0.68): UploadJob {
  return {
    id: `gallery-upload-${status}`,
    label: 'Weekly product review',
    status,
    progress,
    startedAt: FIXTURE_TIME,
    folderWebViewLink: 'https://drive.google.com/drive/folders/gallery-preview',
    files: [
      { stream: 'tab', filename: 'meeting-tab.webm', status: 'uploaded', bytes: 181_000_000 },
      { stream: 'mic', filename: 'microphone.webm', status: status === 'completed' ? 'uploaded' : 'uploading', bytes: 18_000_000 },
      { stream: 'self-video', filename: 'camera.webm', status: status === 'completed' ? 'uploaded' : status === 'failed' ? 'retry-pending' : 'uploading', bytes: 49_000_000 },
    ],
  };
}

const savedRecording: RecordingHistoryEntry = {
  id: 'gallery-history-alex',
  name: 'Customer interview — Alex',
  createdAt: Date.UTC(2026, 6, 25, 10, 0, 0),
  durationMs: 2_538_000,
  storageMode: 'drive',
  status: 'complete',
  files: [
    { id: 'gallery-tab', stream: 'tab', filename: 'meeting-tab.webm', destination: 'drive', status: 'available', bytes: 181_000_000, webViewLink: 'https://drive.google.com/file/d/gallery-tab/view' },
    { id: 'gallery-mic', stream: 'mic', filename: 'microphone.webm', destination: 'drive', status: 'available', bytes: 18_000_000, webViewLink: 'https://drive.google.com/file/d/gallery-mic/view' },
    { id: 'gallery-camera', stream: 'self-video', filename: 'camera.webm', destination: 'drive', status: 'available', bytes: 49_000_000, webViewLink: 'https://drive.google.com/file/d/gallery-camera/view' },
    { id: 'gallery-transcript', stream: 'tab', filename: 'transcript.vtt', destination: 'drive', status: 'available', bytes: 84_000, webViewLink: 'https://drive.google.com/file/d/gallery-transcript/view' },
  ],
};

const designSync: RecordingHistoryEntry = {
  id: 'gallery-history-design',
  name: 'Design sync',
  createdAt: Date.UTC(2026, 6, 24, 10, 0, 0),
  durationMs: 1_684_000,
  storageMode: 'local',
  status: 'complete',
  files: [
    { id: 'gallery-design-tab', stream: 'tab', filename: 'design-sync.webm', destination: 'local', status: 'available', bytes: 122_000_000, downloadId: 1 },
  ],
};

const activeRecording = session({
  phase: 'recording',
  recordedMs: 754_000,
  tabResolution: { width: 1920, height: 1080 },
  capturedDevices: {
    microphone: 'MacBook Pro Microphone',
    camera: 'FaceTime HD Camera',
  },
});

export const POPUP_STORIES: PopupStory[] = [
  {
    id: 'setup-default', title: 'Default', group: 'Setup',
    description: 'Idle setup with capture details collapsed.',
    preview: { screen: 'session', session: session() },
  },
  {
    id: 'setup-expanded', title: 'Camera + mic options', group: 'Setup',
    description: 'Expanded capture controls, separate mic, camera enabled, and a resolution nudge.',
    preview: {
      screen: 'session', session: session(),
      setup: { cameraWarningText: 'Camera delivering 720p · raise in settings' },
    },
    shell: { captureDetailsExpanded: true },
  },
  {
    id: 'setup-mic-required', title: 'Microphone required', group: 'Setup',
    description: 'Inline permission CTA and persistent setup warning.',
    preview: {
      screen: 'session', session: session(),
      setup: { micPermissionRequired: true },
    },
  },
  {
    id: 'permission-request', title: 'Permission request', group: 'Permissions',
    description: 'Mic is ready while camera permission still needs a browser prompt.',
    preview: { screen: 'permission', microphone: 'granted', camera: 'prompt' },
  },
  {
    id: 'permission-blocked', title: 'Permission blocked', group: 'Permissions',
    description: 'Browser-denied mic and camera with recovery instructions.',
    preview: { screen: 'permission', microphone: 'denied', camera: 'denied' },
  },
  {
    id: 'recording-starting', title: 'Starting', group: 'Recording',
    description: 'Capture acquisition in progress with controls temporarily disabled.',
    preview: { screen: 'session', session: session({ phase: 'starting', capturedDevices: {} }) },
  },
  {
    id: 'recording-active', title: 'Active', group: 'Recording',
    description: 'Normal recording with transcript, mic, camera, and delivered resolution.',
    preview: { screen: 'session', session: activeRecording, transcriptActive: true },
  },
  {
    id: 'recording-interrupted', title: 'Interrupted mid-note', group: 'Saving',
    description: 'n4 — the tab closed. The capture is already saved; this reports what happened and what was kept.',
    preview: {
      screen: 'session',
      session: session({
        phase: 'idle',
        interruption: { reason: 'tab-closed', atMs: 401_000, historyId: 'gallery-history-alex' },
      }),
      notations: [
        { id: 'n1', tStartMs: 48_000, tEndMs: 85_000, endedBy: 'user', text: 'Q3 target changed' },
        { id: 'n2', tStartMs: 154_000, tEndMs: 209_000, endedBy: 'user', text: 'Pricing objection' },
        { id: 'n3', tStartMs: 372_000, tEndMs: 401_000, endedBy: 'auto', text: 'Renewal date' },
      ],
    },
  },
  {
    id: 'recording-notes-empty', title: 'Notes · nothing yet', group: 'Recording',
    description: 'marks-e5 — the "Make a note" capture row and the ⌥M shortcut tip, before any note exists.',
    preview: { screen: 'session', session: activeRecording, transcriptActive: true, notations: [] },
  },
  {
    id: 'recording-notes-span', title: 'Notes · span growing', group: 'Recording',
    description: 'marks-2a — spans drawn to scale on the ribbon, the newest still open and counting up.',
    preview: {
      screen: 'session',
      session: session({ ...activeRecording, recordedMs: 380_000, runningSince: undefined }),
      transcriptActive: true,
      notations: [
        { id: 'notation:1', tStartMs: 41_000, tEndMs: 78_000, endedBy: 'user', text: 'Q3 target changed' },
        { id: 'notation:2', tStartMs: 154_000, tEndMs: 209_000, endedBy: 'user', text: 'Pricing objection' },
        { id: 'notation:3', tStartMs: 315_000, text: '' },
      ],
    },
  },
  {
    id: 'recording-notes-paused', title: 'Notes · pause holds the note', group: 'Recording',
    description: 'd3 — the ribbon stops growing and the open note says HELD rather than running across a gap.',
    preview: {
      screen: 'session',
      session: session({ ...activeRecording, paused: true, recordedMs: 432_000, runningSince: undefined }),
      notations: [
        { id: 'notation:1', tStartMs: 41_000, tEndMs: 78_000, endedBy: 'user', text: 'Q3 target changed' },
        { id: 'notation:2', tStartMs: 154_000, tEndMs: 209_000, endedBy: 'user', text: 'Pricing objection' },
        { id: 'notation:3', tStartMs: 334_000, text: 'Migration owner' },
      ],
    },
  },
  {
    id: 'recording-notes-sealed', title: 'Notes · sealed by the run', group: 'Recording',
    description: 'A note the run outlived: closed at the last recorded frame and marked, never discarded.',
    preview: {
      screen: 'session',
      session: session({ ...activeRecording, recordedMs: 401_000, runningSince: undefined }),
      transcriptActive: true,
      notations: [
        { id: 'notation:1', tStartMs: 41_000, tEndMs: 78_000, endedBy: 'user', text: 'Q3 target changed' },
        { id: 'notation:2', tStartMs: 372_000, tEndMs: 401_000, endedBy: 'auto', text: 'Renewal date' },
      ],
    },
  },
  {
    id: 'recording-paused', title: 'Paused', group: 'Recording',
    description: 'Pause-aware timer, summary metadata, and resume/finish actions.',
    preview: { screen: 'session', session: session({ ...activeRecording, paused: true }), transcriptActive: true },
  },
  {
    id: 'recording-muted', title: 'Muted + background upload', group: 'Recording',
    description: 'Mic muted, camera hidden, warning text, and a concurrent upload shortcut.',
    preview: {
      screen: 'session',
      session: session({
        ...activeRecording,
        micMuted: true,
        cameraMuted: true,
        warnings: ['Microphone is muted', 'Camera is hidden'],
        uploadJobs: [uploadJob('uploading', 0.63)],
      }),
      transcriptActive: true,
    },
  },
  {
    id: 'finalizing', title: 'Finalizing', group: 'Saving',
    description: 'Indeterminate sealing/muxing state before local delivery or upload handoff.',
    preview: { screen: 'session', session: session({ phase: 'stopping', recordedMs: 754_000 }) },
  },
  {
    id: 'upload-completed-notes', title: 'Upload complete · notes', group: 'Saving',
    description: 'n2a \u2192 n2c — the saved screen folds its notes behind YOUR NOTES; the heading opens them.',
    preview: {
      screen: 'session',
      session: session({ uploadJobs: [{ ...uploadJob('completed', 1), historyId: 'gallery-history-alex' }] }),
      selectedUploadJobId: uploadJob('completed', 1).id,
      notations: [
        { id: 'n1', tStartMs: 48_000, tEndMs: 85_000, endedBy: 'user', text: 'Q3 target changed' },
        { id: 'n2', tStartMs: 154_000, tEndMs: 209_000, endedBy: 'user', text: 'Pricing objection' },
        { id: 'n3', tStartMs: 312_000, tEndMs: 376_000, endedBy: 'auto', text: '' },
      ],
    },
  },
  {
    id: 'notes-naming', title: 'Notes · naming the open note', group: 'Recording',
    description: 'The open note is named where it happens — the capture row becomes the name and its start.',
    preview: {
      screen: 'session',
      session: session({ phase: 'recording', recordedMs: 380_000, runningSince: FIXTURE_TIME }),
      notations: [
        { id: 'n1', tStartMs: 48_000, tEndMs: 85_000, endedBy: 'user', text: 'Q3 target changed' },
        { id: 'n2', tStartMs: 334_000, text: 'Drive quota limit' },
      ],
    },
  },
  {
    id: 'upload-progress-notes', title: 'Upload in progress · notes', group: 'Saving',
    description: 'd4 — the notes sidecar goes up ahead of the media, above the folded notes list.',
    preview: {
      screen: 'session',
      session: session({
        uploadJobs: [{
          ...uploadJob('uploading', 0.34),
          historyId: 'gallery-history-alex',
          // The sidecar is delivered first, so it is still uploading here.
          files: [
            { stream: 'tab', filename: 'notes.vtt', status: 'uploading', bytes: 4_100, kind: 'notes' },
            ...uploadJob('uploading', 0.34).files,
          ],
        }],
      }),
      selectedUploadJobId: uploadJob('uploading', 0.34).id,
      notations: [
        { id: 'n1', tStartMs: 48_000, tEndMs: 85_000, endedBy: 'user', text: 'Q3 target changed' },
      ],
    },
  },
  ...(['uploading', 'completed', 'failed'] as const).map((status): PopupStory => {
    const job = uploadJob(status, status === 'completed' ? 1 : 0.68);
    const title = status === 'uploading' ? 'Upload in progress' : status === 'completed' ? 'Upload complete' : 'Upload incomplete';
    const description = status === 'uploading'
      ? 'Aggregate and per-file Drive progress with cancel and background actions.'
      : status === 'completed'
        ? 'Saved confirmation, Drive file list, transcript, and next actions.'
        : 'Partial success with a retry path and retained file progress.';
    return {
      id: `upload-${status === 'uploading' ? 'progress' : status}`,
      title,
      group: 'Saving',
      description,
      preview: {
        screen: 'session',
        session: session({ uploadJobs: [job] }),
        selectedUploadJobId: job.id,
      },
    };
  }),
  {
    id: 'recordings-recent', title: 'Recent recordings', group: 'Library',
    description: 'In-flight upload plus recent saved recordings.',
    preview: { screen: 'recordings', session: session({ uploadJobs: [uploadJob()] }), entries: [savedRecording, designSync] },
  },
  {
    id: 'recordings-notes', title: 'Recordings · notes', group: 'Library',
    description: 'n1 — a gold count chip on each row; tapping it threads that recording\u2019s notes underneath.',
    preview: {
      screen: 'recordings',
      session: session({}),
      entries: [{ ...savedRecording, name: 'Weekly sync', durationMs: 1_360_000 }, designSync],
      notations: [
        { id: 'n1', tStartMs: 154_000, tEndMs: 209_000, endedBy: 'user', text: 'Pricing objection' },
        { id: 'n2', tStartMs: 312_000, tEndMs: 376_000, endedBy: 'user', text: 'Migration owner' },
        { id: 'n3', tStartMs: 1_082_000, tEndMs: 1_130_000, endedBy: 'auto', text: '' },
      ],
    },
  },
  {
    id: 'recordings-empty', title: 'Empty recordings', group: 'Library',
    description: 'First-run empty state and navigation actions.',
    preview: { screen: 'recordings', entries: [] },
  },
  {
    id: 'recording-detail', title: 'Saved recording detail', group: 'Library',
    description: 'Drive files, transcript metadata, rename, and open/copy actions.',
    preview: { screen: 'recording-detail', target: { kind: 'recording', entry: savedRecording } },
  },
  {
    id: 'recording-detail-notes', title: 'Saved recording · notes', group: 'Library',
    description: 'd1 — every note on the finished recording\u2019s own timeline, with the list beneath it.',
    preview: {
      screen: 'recording-detail',
      target: { kind: 'recording', entry: { ...savedRecording, name: 'Weekly sync', durationMs: 1_360_000 } },
      notations: [
        { id: 'n1', tStartMs: 48_000, tEndMs: 85_000, endedBy: 'user', text: 'Q3 target changed' },
        { id: 'n2', tStartMs: 154_000, tEndMs: 209_000, endedBy: 'user', text: 'Pricing objection' },
        { id: 'n3', tStartMs: 312_000, tEndMs: 376_000, endedBy: 'user', text: 'Migration owner' },
        { id: 'n4', tStartMs: 500_000, tEndMs: 541_000, endedBy: 'user', text: 'Security review date' },
        { id: 'n5', tStartMs: 666_000, tEndMs: 738_000, endedBy: 'user', text: 'Headcount ask' },
        { id: 'n6', tStartMs: 877_000, tEndMs: 906_000, endedBy: 'user', text: 'Renewal date' },
        { id: 'n7', tStartMs: 1_074_000, tEndMs: 1_119_000, endedBy: 'auto', text: '' },
      ],
    },
  },
  {
    id: 'upload-detail', title: 'Upload detail', group: 'Library',
    description: 'Pushed detail view for an upload that is still running.',
    preview: { screen: 'recording-detail', target: { kind: 'upload', job: uploadJob() } },
  },
  {
    id: 'device-picker', title: 'Device picker', group: 'Overlays',
    description: 'Recording state with the live microphone picker sheet open.',
    preview: {
      screen: 'session',
      session: activeRecording,
      devicePicker: {
        device: 'microphone',
        options: [
          { id: 'macbook', label: 'MacBook Pro Microphone', selected: true },
          { id: 'studio', label: 'Studio Display Microphone' },
          { id: 'airpods', label: 'AirPods Pro' },
        ],
      },
    },
  },
  {
    id: 'recording-menu', title: 'Recording menu', group: 'Overlays',
    description: 'Active recording with destructive and development menu actions visible.',
    preview: { screen: 'session', session: activeRecording, transcriptActive: true },
    shell: { menuOpen: true },
  },
];

export function popupStory(storyId: string): PopupStory | undefined {
  return POPUP_STORIES.find((story) => story.id === storyId);
}
