/**
 * @file popup/PopupNotations.ts
 *
 * Every notation read and write the popup makes, and the one place that knows
 * whether it is talking to the background or to a static preview fixture.
 *
 * That single switch is the reason this is a module. The gallery renders the
 * real popup markup with no extension behind it, so *any* surface that reaches
 * for notes has to answer from the fixture instead — and each surface that
 * learned this rule separately got it wrong at least once.
 *
 * The live commands name no run. Every live command in this protocol means "the
 * one happening now" (`SET_PAUSED`, `STOP_RECORDING`), so the background
 * resolves the active `historyId` and the popup never carries it.
 */

import type { RecordingNotesDetailActions } from './RecordingNotesDetail';
import { sendToBackground } from '../shared/messages';
import type { RecordingNotation } from '../shared/notations';
import type {
  PopupEndNotation,
  PopupListRecordingNotations,
  PopupMarkNotation,
  PopupRemoveActiveNotation,
  PopupRemoveRecordingNotation,
  PopupUpdateActiveNotation,
  PopupUpdateRecordingNotation,
} from '../shared/protocol';
import type { RecordingHistoryEntry } from '../shared/recordingHistory';

type LiveCommand =
  | PopupMarkNotation
  | PopupEndNotation
  | PopupUpdateActiveNotation
  | PopupRemoveActiveNotation;

type KeyedCommand =
  | PopupListRecordingNotations
  | PopupUpdateRecordingNotation
  | PopupRemoveRecordingNotation;

export type PopupNotationsActions = {
  notify: (message: string) => void;
  /** Repaints the live ribbon after any command that could have changed it. */
  onActiveChanged: (notations: RecordingNotation[]) => void;
};

export class PopupNotations {
  /** The active run's notes, mirrored so the discard prompt can name them. */
  private active: RecordingNotation[] = [];
  /** Static notations for gallery previews; null in the real popup. */
  private preview: RecordingNotation[] | null = null;

  constructor(private readonly actions: PopupNotationsActions) {}

  /** Switches every read to a fixture. Null restores the background. */
  usePreview(notations: RecordingNotation[] | null): void {
    this.preview = notations;
    if (notations) {
      this.active = notations;
      this.actions.onActiveChanged(notations);
    }
  }

  get previewing(): boolean {
    return this.preview != null;
  }

  /** The active run's notes as last read — what the discard prompt counts. */
  get activeNotations(): RecordingNotation[] {
    return this.active;
  }

  /** Re-reads the active run's notations and repaints the ribbon. */
  async refreshActive(): Promise<void> {
    try {
      const response = await sendToBackground({ type: 'LIST_ACTIVE_NOTATIONS' });
      if (response.ok) {
        this.active = response.notations;
        this.actions.onActiveChanged(response.notations);
      }
    } catch (error) {
      console.warn('[popup] LIST_ACTIVE_NOTATIONS failed', error);
    }
  }

  mark(): Promise<void> {
    return this.runLive({ type: 'MARK_NOTATION' }, 'Could not start a note');
  }

  end(id: string): Promise<void> {
    return this.runLive({ type: 'END_NOTATION', id }, 'Could not end the note');
  }

  save(id: string, text: string): Promise<void> {
    return this.runLive({ type: 'UPDATE_ACTIVE_NOTATION', id, text }, 'Could not save the note');
  }

  remove(id: string): Promise<void> {
    return this.runLive({ type: 'REMOVE_ACTIVE_NOTATION', id }, 'Could not delete the note');
  }

  /** One recording's notations, or the preview fixture. */
  async list(recordingId: string): Promise<RecordingNotation[]> {
    if (this.preview) return this.preview;
    return await this.readKeyed({ type: 'LIST_RECORDING_NOTATIONS', recordingId });
  }

  /** How many notes each listed recording has, in one read. */
  async counts(entries: RecordingHistoryEntry[]): Promise<Record<string, number>> {
    if (this.preview) {
      return entries[0] ? { [entries[0].id]: this.preview.length } : {};
    }
    try {
      const response = await sendToBackground({
        type: 'LIST_RECORDING_NOTATION_SUMMARIES',
        recordingIds: entries.map((entry) => entry.id),
      });
      return response.ok
        ? Object.fromEntries(Object.entries(response.summaries).map(([id, summary]) => [id, summary.count]))
        : {};
    } catch { return {}; }
  }

  /**
   * Keyed reads/writes for a finished recording. In preview the list is served
   * and mutated in memory, so the gallery never talks to the background.
   */
  detailActions(): RecordingNotesDetailActions {
    const preview = this.preview;
    if (preview) {
      let current = [...preview];
      return {
        load: async () => current,
        rename: async (_recordingId, id, text) => {
          current = current.map((n) => (n.id === id ? { ...n, text: text.trim() } : n));
          return current;
        },
        remove: async (_recordingId, id) => {
          current = current.filter((n) => n.id !== id);
          return current;
        },
      };
    }
    return {
      load: (recordingId) => this.readKeyed({ type: 'LIST_RECORDING_NOTATIONS', recordingId }),
      rename: (recordingId, id, text) =>
        this.readKeyed({ type: 'UPDATE_RECORDING_NOTATION', recordingId, id, text }),
      remove: (recordingId, id) =>
        this.readKeyed({ type: 'REMOVE_RECORDING_NOTATION', recordingId, id }),
    };
  }

  /**
   * Runs one live command and re-reads the list. Deliberately quiet on success:
   * starting and ending a note must not interrupt the meeting, so only a failure
   * is worth a notice.
   */
  private async runLive(message: LiveCommand, fallbackError: string): Promise<void> {
    try {
      const response = await sendToBackground(message);
      if (!response.ok) this.actions.notify(response.error || fallbackError);
    } catch (error) {
      console.warn(`[popup] ${message.type} failed`, error);
      this.actions.notify(fallbackError);
    }
    await this.refreshActive();
  }

  /** Sends a keyed command and returns the resulting list, reporting failures. */
  private async readKeyed(message: KeyedCommand): Promise<RecordingNotation[]> {
    const response = await sendToBackground(message);
    if (response.ok) return response.notations;
    this.actions.notify(response.error || 'Could not read the notes for this recording');
    throw new Error(response.error);
  }
}
