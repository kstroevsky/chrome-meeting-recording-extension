import type { NotationResult } from '../../shared/protocol';
import type { RecordingSession } from './session/RecordingSession';
import type { RecordingNotationService } from '../library/notations/RecordingNotationService';

export class RecordingNotationCommands {
  constructor(
    private readonly deps: {
      L: { log: (...a: any[]) => void; warn: (...a: any[]) => void };
      session: RecordingSession;
      notations?: RecordingNotationService;
    },
  ) {}

  async mark(text?: string): Promise<NotationResult> {
    const snapshot = this.deps.session.getSnapshot();
    if (snapshot.phase !== 'recording') {
      return { ok: false, error: 'Mark requested but no recording is active' };
    }
    if (!snapshot.historyId) {
      return { ok: false, error: 'The active recording has no history identity' };
    }
    if (!this.deps.notations) {
      return { ok: false, error: 'Recording notations are unavailable' };
    }

    try {
      const notation = await this.deps.notations.add(snapshot.historyId, {
        tStartMs: this.deps.session.currentRecordedMs(),
        text,
      });
      this.deps.L.log('Marked notation', notation.id, 'at', notation.tStartMs, 'ms');
      return { ok: true, notation };
    } catch (error: any) {
      const message = `MARK_NOTATION failed: ${error?.message || error}`;
      this.deps.L.warn(message);
      return { ok: false, error: message };
    }
  }

  async toggle(): Promise<NotationResult> {
    const { historyId, phase } = this.deps.session.getSnapshot();
    if (phase !== 'recording' || !historyId) {
      return { ok: false, error: 'Mark requested but no recording is active' };
    }
    if (!this.deps.notations) {
      return { ok: false, error: 'Recording notations are unavailable' };
    }

    try {
      const open = (await this.deps.notations.list(historyId))
        .find((notation) => notation.tEndMs == null);
      return open ? await this.end(open.id) : await this.mark();
    } catch (error: any) {
      const message = `TOGGLE_NOTATION failed: ${error?.message || error}`;
      this.deps.L.warn(message);
      return { ok: false, error: message };
    }
  }

  async end(id: string): Promise<NotationResult> {
    const snapshot = this.deps.session.getSnapshot();
    if (snapshot.phase !== 'recording') {
      return { ok: false, error: 'Mark end requested but no recording is active' };
    }
    if (!snapshot.historyId) {
      return { ok: false, error: 'The active recording has no history identity' };
    }
    if (!this.deps.notations) {
      return { ok: false, error: 'Recording notations are unavailable' };
    }

    try {
      const notation = await this.deps.notations.endOpen(
        snapshot.historyId,
        id,
        this.deps.session.currentRecordedMs(),
      );
      return { ok: true, notation };
    } catch (error: any) {
      const message = `END_NOTATION failed: ${error?.message || error}`;
      this.deps.L.warn(message);
      return { ok: false, error: message };
    }
  }
}
