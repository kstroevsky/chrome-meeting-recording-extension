/** Development-only deterministic inputs for the real popup preview renderer. */

import type {
  PopupPreviewShellState,
  PopupPreviewState,
} from '../popupPreviewState';
import type { RecordingStatusView, StorageMode, UploadJob } from '../../shared/recording';
import { contentTypeForRecordingFilename } from '../../shared/recordingFormats';
import {
  deliveryFromLegacyFields,
  locationsFromLegacyFields,
  type RecordingHistoryEntry,
  type RecordingHistoryFile,
} from '../../shared/recordingHistory';

/**
 * Gallery fixtures are written in the pre-ADR-0006 single-destination shape.
 * Filling the replica fields the same way a legacy row normalizes keeps the
 * fixtures short and keeps them honest about what a migrated row looks like.
 */
function legacyFixtureFile(
  file: Omit<RecordingHistoryFile, 'mimeType' | 'locations' | 'delivery'>,
  requested: StorageMode,
): RecordingHistoryFile {
  return {
    ...file,
    mimeType: contentTypeForRecordingFilename(file.filename),
    locations: locationsFromLegacyFields(file),
    delivery: deliveryFromLegacyFields(file, requested),
  };
}

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

const MB = 1024 * 1024;

/**
 * Mirrors the design's saving (d4) and saved (n2a) cards: the microphone is up,
 * the tab is two-thirds through, the camera is still waiting its turn.
 */
function uploadJob(status: UploadJob['status'] = 'uploading', progress = 0.68): UploadJob {
  const done = status === 'completed';
  return {
    id: `gallery-upload-${status}`,
    label: 'Weekly product review',
    status,
    progress,
    startedAt: FIXTURE_TIME,
    folderWebViewLink: 'https://drive.google.com/drive/folders/gallery-preview',
    files: [
      { stream: 'tab', filename: 'meeting-tab.webm', bytes: 214 * MB, webViewLink: 'https://drive.google.com/file/d/gallery-tab/view',
        ...(status === 'uploading'
          ? { status: 'uploading' as const, uploadedBytes: Math.round(214 * MB * 0.67) }
          : status === 'failed' ? { status: 'fallback' as const } : { status: 'uploaded' as const }) },
      { stream: 'mic', filename: 'microphone.webm', status: status === 'failed' ? 'fallback' : 'uploaded', bytes: 12 * MB, webViewLink: 'https://drive.google.com/file/d/gallery-mic/view' },
      // Kilobytes, and up before the media: the saved screen lists it under the files (n2a).
      { stream: 'tab', kind: 'transcript' as const, filename: 'transcript.vtt', status: 'uploaded' as const, bytes: 34_800, webViewLink: 'https://drive.google.com/file/d/gallery-transcript/view' },
      { stream: 'self-video', filename: 'camera.webm', status: done ? 'uploaded' : status === 'uploading' ? 'uploading' : 'fallback', bytes: 58 * MB, ...(done ? { webViewLink: 'https://drive.google.com/file/d/gallery-camera/view' } : {}) },
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
    legacyFixtureFile({ id: 'gallery-tab', stream: 'tab', filename: 'meeting-tab.webm', destination: 'drive', status: 'available', bytes: 181_000_000, webViewLink: 'https://drive.google.com/file/d/gallery-tab/view' }, 'drive'),
    legacyFixtureFile({ id: 'gallery-mic', stream: 'mic', filename: 'microphone.webm', destination: 'drive', status: 'available', bytes: 18_000_000, webViewLink: 'https://drive.google.com/file/d/gallery-mic/view' }, 'drive'),
    legacyFixtureFile({ id: 'gallery-camera', stream: 'self-video', filename: 'camera.webm', destination: 'drive', status: 'available', bytes: 49_000_000, webViewLink: 'https://drive.google.com/file/d/gallery-camera/view' }, 'drive'),
    legacyFixtureFile({ id: 'gallery-transcript', stream: 'tab', filename: 'transcript.vtt', destination: 'drive', status: 'available', bytes: 84_000, webViewLink: 'https://drive.google.com/file/d/gallery-transcript/view' }, 'drive'),
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
    legacyFixtureFile({ id: 'gallery-design-tab', stream: 'tab', filename: 'design-sync.webm', destination: 'local', status: 'available', bytes: 122_000_000, downloadId: 1 }, 'local'),
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
      savedDurationMs: 1_360_000,
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
      // Frozen like the other notes stories: a running clock would drift off 2a's 06:20.
      session: session({ ...activeRecording, recordedMs: 380_000, runningSince: undefined }),
      transcriptActive: true,
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
          // The sidecars are delivered first: d4 shows them already up, media still moving.
          files: [
            { stream: 'tab', filename: 'notes.vtt', status: 'uploaded', bytes: 4_100, kind: 'notes' },
            { stream: 'tab', filename: 'transcript.vtt', status: 'uploaded', bytes: 34_800, kind: 'transcript' },
            ...uploadJob('uploading', 0.34).files,
          ],
        }],
      }),
      selectedUploadJobId: uploadJob('uploading', 0.34).id,
      savedDurationMs: 1_360_000,
      notations: [
        { id: 'n1', tStartMs: 48_000, tEndMs: 85_000, endedBy: 'user', text: 'Q3 target changed' },
      ],
    },
  },
  ...(['uploading', 'completed', 'failed', 'partial'] as const).map((status): PopupStory => {
    const job = uploadJob(status, status === 'uploading' ? 0.68 : 1);
    const copy = {
      uploading: ['Upload in progress', 'd4 — each file with its own state: saved, uploading with its share, or queued.'],
      completed: ['Upload complete', 'n2a — saved confirmation, the Drive block with open arrows, transcript, and next actions.'],
      failed: ['Upload failed', '8A — the outcome leads; every file says DONE or FAILED and why nothing was lost.'],
      partial: ['Upload partly saved', '8C — what landed is shareable now; the one file that did not offers its retry in place.'],
    }[status];
    return {
      id: `upload-${status === 'uploading' ? 'progress' : status}`,
      title: copy[0],
      group: 'Saving',
      description: copy[1],
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
    id: 'recording-detail-rename', title: 'Saved recording · renaming', group: 'Library',
    description: '7H — the name is edited in the header; the body lists the files the name will rename.',
    preview: {
      screen: 'recording-detail',
      target: { kind: 'recording', entry: { ...savedRecording, name: 'Weekly sync', durationMs: 1_360_000 } },
      renaming: true,
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
  ...([false, true] as const).map((folders): PopupStory => ({
    id: folders ? 'naming-folders' : 'naming',
    title: folders ? 'Naming · folders exist' : 'Naming · no folders',
    group: 'Overlays',
    description: folders
      ? '9FL — the name, then FOLDER as a field; Save and the quiet way out.'
      : '9L — the name with where it already lives under it.',
    preview: {
      screen: 'session',
      session: session({ uploadJobs: [{ ...uploadJob('completed', 1), label: 'Team sync — Jul 11', namingStatus: 'pending', historyId: 'gallery-history-alex' }] }),
      selectedUploadJobId: uploadJob('completed', 1).id,
      naming: {
        folders: folders
          ? [{ id: 'weekly', name: 'Weekly meetings' }, { id: 'clients', name: 'Client calls' }]
          : [],
      },
    },
  })),
  {
    id: 'naming-folders-open', title: 'Naming · folder list open', group: 'Overlays',
    description: '9FD — open, the list takes the field\'s place in the flow; the picked folder is tinted and ticked.',
    preview: {
      screen: 'session',
      session: session({ uploadJobs: [{ ...uploadJob('completed', 1), label: 'Team sync — Jul 11', namingStatus: 'pending', historyId: 'gallery-history-alex' }] }),
      selectedUploadJobId: uploadJob('completed', 1).id,
      naming: {
        folders: [{ id: 'weekly', name: 'Weekly meetings' }, { id: 'clients', name: 'Client calls' }, { id: 'interviews', name: 'Interviews' }],
        picked: 'weekly',
        open: true,
      },
    },
  },
  {
    id: 'naming-folders-search', title: 'Naming · many folders, searched', group: 'Overlays',
    description: '7D — past eight folders the list gains a search row, and says how many it kept.',
    preview: {
      screen: 'session',
      session: session({ uploadJobs: [{ ...uploadJob('completed', 1), label: 'Team sync — Jul 11', namingStatus: 'pending', historyId: 'gallery-history-alex' }] }),
      selectedUploadJobId: uploadJob('completed', 1).id,
      naming: {
        folders: ['Weekly meetings', 'Weekly 1-1s', 'Weekly review — eng', 'Biweekly design crit', 'Client calls', 'Interviews', 'Hiring loop', 'Board prep', 'Quarterly planning', 'Sales demos', 'Onboarding', 'Retros', 'Standups', 'Design reviews', 'Security', 'Legal', 'Finance', 'Support escalations', 'Partner calls', 'Research', 'All hands', 'Offsite', 'Vendor calls', 'Product sync', 'Marketing', 'Customer advisory'].map((name, index) => ({ id: `folder-${index}`, name })),
        picked: 'folder-0',
        open: true,
        query: 'wee',
      },
    },
  },
  {
    id: 'discard-confirm', title: 'Discard confirmation', group: 'Overlays',
    description: 'n3 — the stake in bold, and the notes a discard would take, named rather than implied.',
    preview: {
      screen: 'session',
      session: session({ ...activeRecording, recordedMs: 1_360_000, runningSince: undefined }),
      transcriptActive: true,
      confirmDiscard: true,
      notations: [
        { id: 'n1', tStartMs: 154_000, tEndMs: 209_000, endedBy: 'user', text: 'Pricing objection' },
        { id: 'n2', tStartMs: 312_000, tEndMs: 376_000, endedBy: 'user', text: 'Migration owner' },
        { id: 'n3', tStartMs: 1_082_000, tEndMs: 1_130_000, endedBy: 'user', text: '' },
      ],
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
