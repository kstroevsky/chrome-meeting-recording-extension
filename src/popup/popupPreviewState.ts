/**
 * Deterministic inputs for the development popup preview.
 *
 * These are deliberately domain-shaped rather than DOM-shaped: production
 * renderers receive the same sessions, upload jobs, permission results, and
 * history entries they normally receive from Chrome. The gallery owns fixture
 * values; PopupController owns all markup and layout decisions.
 */

import type { RecordingNotation } from '../shared/notations';
import type {
  RecordingInputDevice,
  RecordingStatusView,
  UploadJob,
} from '../shared/recording';
import type { RecordingHistoryEntry } from '../shared/recordingHistory';

export type PopupPreviewPermissionState = 'granted' | 'denied' | 'prompt' | 'unknown';

export type PopupPreviewDeviceOption = {
  id: string;
  label: string;
  selected?: boolean;
};

export type PopupPreviewDevicePicker = {
  device: RecordingInputDevice;
  options: PopupPreviewDeviceOption[];
};

export type PopupPreviewState =
  | {
      screen: 'session';
      session: RecordingStatusView;
      /** The live-caption poll would normally provide this asynchronously. */
      transcriptActive?: boolean;
      /** Notes on the live run, which the background would normally supply. */
      notations?: RecordingNotation[];
      /** Selects a detached upload tab after the session has been rendered. */
      selectedUploadJobId?: string;
      /** A focused setup-only condition owned by the real setup controls. */
      setup?: {
        micPermissionRequired?: boolean;
        /** Setup nudge text supplied by the self-video capability/profile path. */
        cameraWarningText?: string;
      };
      devicePicker?: PopupPreviewDevicePicker;
    }
  | {
      screen: 'permission';
      microphone: PopupPreviewPermissionState;
      camera: PopupPreviewPermissionState;
    }
  | {
      screen: 'recordings';
      /** Notes attached to the previewed rows, which the background would supply. */
      notations?: RecordingNotation[];
      entries: RecordingHistoryEntry[];
      /** An active upload can appear above durable recording history. */
      session?: RecordingStatusView;
    }
  | {
      screen: 'recording-detail';
      /** Notes for the previewed recording, which the background would supply. */
      notations?: RecordingNotation[];
      target: { kind: 'recording'; entry: RecordingHistoryEntry } | { kind: 'upload'; job: UploadJob };
    };

/** Shell state is separate because the menu and setup disclosure are not controller state. */
export type PopupPreviewShellState = {
  menuOpen?: boolean;
  captureDetailsExpanded?: boolean;
};
