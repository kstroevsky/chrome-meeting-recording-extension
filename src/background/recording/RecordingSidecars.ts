import { loadExtensionSettingsFromStorage } from '../../shared/settings';
import { hasExportableNotations, toWebVtt } from '../../shared/notationExport';
import { hasExportableTranscript, transcriptToWebVtt } from '../../shared/transcriptExport';
import type { RecordingSession } from './session/RecordingSession';
import type { RecordingNotationService } from '../library/notations/RecordingNotationService';
import type { RecordingTranscriptService } from '../library/transcript/RecordingTranscriptService';

export class RecordingSidecars {
  constructor(
    private readonly deps: {
      L: { warn: (...a: any[]) => void };
      session: RecordingSession;
      notations?: RecordingNotationService;
      transcripts?: RecordingTranscriptService;
    },
  ) {}

  async notes(historyId: string | undefined): Promise<{ vtt: string } | undefined> {
    if (!historyId || !this.deps.notations) return undefined;
    try {
      const notations = await this.deps.notations.list(historyId);
      if (!hasExportableNotations(notations)) return undefined;
      return {
        vtt: toWebVtt(notations, {
          durationMs: this.deps.session.runDurationMs(historyId),
        }),
      };
    } catch (error) {
      this.deps.L.warn('Could not export notes for this recording:', error);
      return undefined;
    }
  }

  async transcript(historyId: string | undefined): Promise<{ vtt: string } | undefined> {
    if (!historyId || !this.deps.transcripts) return undefined;
    try {
      const transcript = await this.deps.transcripts.get(historyId);
      if (!transcript || !hasExportableTranscript(transcript)) return undefined;
      return { vtt: transcriptToWebVtt(transcript) };
    } catch (error) {
      this.deps.L.warn('Could not export the transcript for this recording:', error);
      return undefined;
    }
  }

  async driveRootFolderName(): Promise<string | undefined> {
    try {
      return (await loadExtensionSettingsFromStorage()).storage.driveRootFolderName;
    } catch (error) {
      this.deps.L.warn('Could not read the Drive folder name for this recording:', error);
      return undefined;
    }
  }
}
