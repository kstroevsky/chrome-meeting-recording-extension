/**
 * @file recordings/NoteEditor.ts
 *
 * Adding notes to a finished recording (design `f5`, and `f6` without a
 * transcript), reached from ADD beside the note count in the details dialog.
 *
 * A finished recording is read rather than watched, so with a transcript the
 * lines are the editor: dragging over them sets a span, and the composer under
 * them takes the range, the length and the name — the same fields the live
 * popup uses, so a note made a week later is made the way one made during the
 * call is. Without a transcript the timeline is the whole editor: NOTE opens a
 * span at the playhead and END closes it. Both leave to the details dialog,
 * since naming and deleting the rest still happen there.
 *
 * The timeline above stays live. Saved notes sit on it at half height, where
 * they cannot be trimmed by accident; the span being made is drawn full height
 * with a grab handle on each end, and a saved note joins it only when its name
 * is clicked.
 */

import type { RecordingNotation } from '../shared/notations';
import type { Transcript, TranscriptSegment } from '../shared/transcript';
import { masterTrack, type PlaybackManifest } from '../shared/playback';
import { playbackUrl, type PlaybackUrlDeps } from './player/playbackSource';
import { activeSegmentIndex, sortSegments } from './player/playerTranscript';
import { formatClock, seekFraction } from './player/playerFormat';
import {
  editorLines, formatLength, formatSpan, linesInSpan, noteCount, spanOfLines,
  type DraftSpan, type EditorLine,
} from './noteEditorModel';
import { RecordingNotesSection, type RecordingNotesSectionActions } from './RecordingNotesSection';

type NoteFields = { tStartMs: number; tEndMs?: number; text: string };

export type NoteEditorDeps = {
  recording: { id: string; name: string; durationMs?: number };
  notes: Omit<RecordingNotesSectionActions, 'openEditor'> & {
    add: (recordingId: string, note: NoteFields) => Promise<RecordingNotation[]>;
    update: (recordingId: string, id: string, patch: Partial<NoteFields>) => Promise<RecordingNotation[]>;
  };
  /** The recording's transcript (ADR-0007); absent or empty gives the f6 shape. */
  transcript?: (recordingId: string) => Promise<Transcript | undefined>;
  /** How to play the recording; without it the playhead only moves when clicked. */
  playback?: PlaybackUrlDeps & { getManifest: (recordingId: string) => Promise<PlaybackManifest | undefined> };
  /** Back to the details dialog: the back button and Done. */
  onDetails: () => void;
  /** Closed outright: the ×. */
  onClose: () => void;
};

/** A span being made or re-made: a new one, or a saved note opened by its name. */
type Draft = DraftSpan & { noteId: string | null; text: string };

/** A span shorter than this is a slip of the hand, not a note. */
const MIN_SPAN_MS = 1_000;

const BACK_ICON = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.3 2L3.6 6l3.7 4"/></svg>';
const VIDEO_ICON = '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 013.5 3h6A1.5 1.5 0 0111 4.5v1.2l3.2-1.8a.5.5 0 01.8.4v7.4a.5.5 0 01-.8.4L11 10.3v1.2A1.5 1.5 0 019.5 13h-6A1.5 1.5 0 012 11.5v-7z"/></svg>';
const PLAY_ICON = '<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3 1.6l7 4.4-7 4.4z"/></svg>';
const PAUSE_ICON = '<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2.2" y="1.6" width="2.8" height="8.8" rx="0.8"/><rect x="7" y="1.6" width="2.8" height="8.8" rx="0.8"/></svg>';
const PLUS_ICON = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 1.6v6.8M1.6 5h6.8"/></svg>';

const $ = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
};

const button = (className: string, label: string, onClick: () => void): HTMLButtonElement => {
  const element = $('button', className);
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
};

export class NoteEditor {
  readonly element = $('div', 'note-editor-overlay');
  private readonly dialog = $('article', 'note-editor');
  private readonly strip = $('div', 'note-editor__strip');
  private readonly video = $('video', 'note-editor__video');
  private readonly stripTime = $('span', 'note-editor__strip-time');
  private readonly stripTag = $('span', 'note-editor__strip-tag');
  private readonly stripText = $('span', 'note-editor__strip-text');
  private readonly videoChip = $('button', 'note-editor__video-chip');
  private readonly noTranscript = $('span', 'note-editor__no-transcript');
  private readonly playButton = $('button', 'note-editor__play');
  private readonly clock = $('span', 'note-editor__clock');
  private readonly scrub = $('div', 'note-editor__scrub');
  private readonly marks = $('div', 'note-editor__marks');
  private readonly draftMark = $('div', 'note-editor__draft');
  private readonly startHandle = $('span', 'note-editor__handle note-editor__handle--start');
  private readonly endHandle = $('span', 'note-editor__handle note-editor__handle--end');
  private readonly bubble = $('span', 'note-editor__bubble');
  private readonly playhead = $('div', 'note-editor__playhead');
  private readonly duration = $('span', 'note-editor__duration');
  private readonly spanButton = $('button', 'note-editor__span-button');
  private readonly body = $('div', 'note-editor__body');
  private readonly linesHost = $('div', 'note-editor__lines');
  private readonly empty = $('p', 'note-editor__empty');
  private readonly composer = $('div', 'note-editor__composer');
  private readonly composerRange = $('span', 'note-editor__range');
  private readonly composerLength = $('span', 'note-editor__length');
  private readonly nameField = $('input', 'note-editor__name');
  private readonly cancelButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly hint = $('span', 'note-editor__hint');
  private readonly count = $('span', 'note-editor__count');

  private segments: TranscriptSegment[] = [];
  private lines: EditorLine[] = [];
  private lineRows = new Map<number, HTMLElement>();
  private notations: RecordingNotation[] = [];
  private section: RecordingNotesSection | null = null;
  private draft: Draft | null = null;
  private playheadMs = 0;
  private durationMs: number;
  private videoOn = false;
  private playable = false;
  private revoke: (() => void) | null = null;
  private busy = false;
  /** A drag over transcript lines: where it began, and whether it has left that line. */
  private lineDrag: { from: number; moved: boolean } | null = null;
  /** A grab handle being dragged on the timeline. */
  private handleDrag: 'start' | 'end' | null = null;
  private readonly listeners = new AbortController();

  constructor(private readonly deps: NoteEditorDeps) {
    this.durationMs = deps.recording.durationMs ?? 0;
    this.cancelButton = button('note-editor__secondary', 'Cancel', () => this.discard());
    this.saveButton = button('note-editor__primary', 'Save note', () => void this.save());
    this.build();
  }

  /** Reads the notes and the transcript, then the media, and shows the editor. */
  async open(): Promise<void> {
    const [notations, transcript] = await Promise.all([
      this.deps.notes.load(this.deps.recording.id).catch(() => [] as RecordingNotation[]),
      this.deps.transcript?.(this.deps.recording.id).catch(() => undefined),
    ]);
    this.notations = notations;
    this.segments = transcript?.segments.length ? sortSegments(transcript.segments) : [];
    this.durationMs ||= Math.max(0, ...notations.map((note) => note.tEndMs ?? note.tStartMs), ...this.segments.map((line) => line.tEndMs));
    this.dialog.classList.toggle('note-editor--transcript', this.segments.length > 0);
    this.videoChip.hidden = this.segments.length === 0;
    this.noTranscript.hidden = this.segments.length > 0;
    if (!this.segments.length) this.mountNoteList();
    this.render();
    await this.attachMedia();
  }

  /** Stops playback and takes the editor away; the URL is revoked so the file is not pinned. */
  close(): void {
    this.listeners.abort();
    this.video.pause();
    this.video.removeAttribute('src');
    this.revoke?.();
    this.revoke = null;
    this.element.remove();
  }

  private build(): void {
    this.dialog.setAttribute('role', 'dialog');
    this.dialog.setAttribute('aria-modal', 'true');
    this.dialog.setAttribute('aria-label', `Add notes to ${this.deps.recording.name}`);

    // Header: back to Details, the name, and on the right VIDEO (or NO TRANSCRIPT) and ×.
    const header = $('div', 'note-editor__header');
    const left = $('span', 'note-editor__header-left');
    const back = $('button', 'note-editor__back');
    back.type = 'button';
    back.title = 'Back to recording details';
    back.innerHTML = BACK_ICON;
    const backLabel = $('span');
    backLabel.textContent = 'Details';
    back.append(backLabel);
    back.addEventListener('click', () => void this.leave());
    const title = $('span', 'note-editor__title');
    title.textContent = this.deps.recording.name;
    left.append(back, $('span', 'note-editor__divider'), title);
    const right = $('span', 'note-editor__header-right');
    this.videoChip.type = 'button';
    this.videoChip.title = 'Show the video while you mark';
    this.videoChip.innerHTML = VIDEO_ICON;
    this.videoChip.append('VIDEO');
    this.videoChip.addEventListener('click', () => { this.videoOn = !this.videoOn; this.render(); });
    this.noTranscript.textContent = 'NO TRANSCRIPT';
    this.noTranscript.hidden = true;
    const close = $('button', 'note-editor__close');
    close.type = 'button';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';
    close.addEventListener('click', () => this.deps.onClose());
    right.append(this.videoChip, this.noTranscript, close);
    header.append(left, right);

    // The picture, pulled in beside the line under the playhead (VIDEO, f5).
    this.video.preload = 'metadata';
    this.video.setAttribute('playsinline', '');
    const picture = $('div', 'note-editor__picture');
    picture.append(this.video);
    const stripCopy = $('span', 'note-editor__strip-copy');
    const stripMeta = $('span', 'note-editor__strip-meta');
    stripMeta.append(this.stripTime, this.stripTag);
    stripCopy.append(stripMeta, this.stripText);
    this.strip.append(picture, stripCopy);
    this.strip.hidden = true;

    // Transport: play, the clock, the live timeline, the length, NOTE or END.
    const transport = $('div', 'note-editor__transport');
    this.playButton.type = 'button';
    this.playButton.addEventListener('click', () => void this.togglePlay());
    const track = $('div', 'note-editor__track');
    this.startHandle.title = 'Drag to move the start';
    this.endHandle.title = 'Drag to move the end';
    const grip = () => $('span', 'note-editor__grip');
    this.startHandle.append(grip());
    this.endHandle.append(grip());
    this.draftMark.hidden = true;
    this.bubble.hidden = true;
    this.scrub.title = 'Scrub';
    this.scrub.append(track, this.marks, this.draftMark, this.startHandle, this.endHandle, this.playhead, this.bubble);
    this.scrub.addEventListener('pointerdown', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('.note-editor__handle')) return;
      this.seek(seekFraction(event.clientX, this.scrub.getBoundingClientRect()) * this.durationMs);
    });
    for (const [handle, end] of [[this.startHandle, 'start'], [this.endHandle, 'end']] as const) {
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.handleDrag = end;
        this.bubble.hidden = false;
        this.paintTimeline();
      });
    }
    const signal = this.listeners.signal;
    document.addEventListener('pointermove', (event) => this.onPointerMove(event), { signal });
    document.addEventListener('pointerup', () => this.onPointerUp(), { signal });
    document.addEventListener('keydown', (event) => this.onKey(event), { signal });
    this.spanButton.type = 'button';
    this.spanButton.addEventListener('click', () => void this.toggleSpan());
    transport.append(this.playButton, this.clock, this.scrub, this.duration, this.spanButton);

    // The lines (f5) or the saved notes (f6).
    this.linesHost.addEventListener('mousedown', (event) => this.onLinesDown(event));
    this.linesHost.addEventListener('mouseover', (event) => this.onLinesOver(event));
    this.linesHost.addEventListener('dblclick', (event) => {
      const index = this.lineIndexAt(event.target);
      if (index != null) this.startDraft(spanOfLines(this.lines, this.lines.findIndex((line) => line.index === index), this.lines.findIndex((line) => line.index === index)));
    });
    this.empty.textContent = 'No notes yet. NOTE opens one at the playhead.';
    this.empty.hidden = true;
    this.body.append(this.linesHost, this.empty);

    // The composer: the range, its length, and the name — the popup's own field.
    this.nameField.type = 'text';
    this.nameField.maxLength = 500;
    this.nameField.placeholder = 'Name this note';
    this.nameField.setAttribute('aria-label', 'Note name');
    this.nameField.addEventListener('input', () => {
      if (this.draft) this.draft.text = this.nameField.value;
      this.section?.setOpenSpan(this.openRow());
    });
    this.nameField.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.discard(); }
      if (event.key === 'Enter' && this.draft?.tEndMs != null) { event.preventDefault(); void this.save(); }
    });
    const field = $('span', 'note-editor__field');
    field.append(this.nameField);
    this.composer.append(this.composerRange, this.composerLength, field, this.cancelButton, this.saveButton);
    this.composer.hidden = true;

    // Footer: what to do next, the count, and Done.
    const footer = $('div', 'note-editor__footer');
    const side = $('span', 'note-editor__footer-side');
    side.append(this.count, button('note-editor__done', 'Done', () => void this.leave()));
    footer.append(this.hint, side);

    this.dialog.append(header, this.strip, transport, this.body, this.composer, footer);
    this.element.append(this.dialog);
    this.element.addEventListener('click', (event) => { if (event.target === this.element) this.deps.onClose(); });

    this.video.addEventListener('timeupdate', () => this.setPlayhead(this.video.currentTime * 1000));
    this.video.addEventListener('loadedmetadata', () => {
      if (!this.durationMs && Number.isFinite(this.video.duration)) { this.durationMs = this.video.duration * 1000; this.render(); }
    });
    this.video.addEventListener('play', () => this.paintTransport());
    this.video.addEventListener('pause', () => this.paintTransport());
  }

  /** f6: the saved notes in their f2 rows, renamed and deleted there as in Details. */
  private mountNoteList(): void {
    const { load, rename, remove, offerUndo } = this.deps.notes;
    this.section = new RecordingNotesSection(this.deps.recording.id, this.durationMs, { load, rename, remove, offerUndo }, { bare: true });
    this.linesHost.replaceWith(this.section.element);
    void this.section.load().then(() => { this.notations = this.section?.notes ?? this.notations; this.render(); });
  }

  private async attachMedia(): Promise<void> {
    const playback = this.deps.playback;
    if (!playback) return this.paintTransport();
    try {
      const manifest = await playback.getManifest(this.deps.recording.id);
      const track = manifest && masterTrack(manifest);
      if (manifest?.durationMs && !this.durationMs) this.durationMs = manifest.durationMs;
      const resolved = track ? await playbackUrl(this.deps.recording.id, track, playback) : undefined;
      if (resolved && this.element.isConnected !== false) {
        this.revoke = resolved.revoke ?? null;
        this.video.src = resolved.url;
        this.playable = true;
      }
    } catch (error) {
      playback.warn?.('The note editor could not load the recording', error);
    }
    this.render();
  }

  // ─── State changes ──────────────────────────────────────────────────────────

  private startDraft(span: DraftSpan, from?: RecordingNotation): void {
    this.draft = { ...span, noteId: from?.id ?? null, text: from?.text ?? this.draft?.text ?? '' };
    this.nameField.value = this.draft.text;
    this.render();
    this.nameField.focus();
  }

  /** NOTE opens a span at the playhead; END closes it, and closing it keeps it (f6). */
  private async toggleSpan(): Promise<void> {
    if (this.draft && this.draft.tEndMs == null) {
      this.draft.tEndMs = Math.max(this.playheadMs, this.draft.tStartMs + MIN_SPAN_MS);
      await this.save();
      return;
    }
    this.startDraft({ tStartMs: this.playheadMs, tEndMs: null });
  }

  private discard(): void {
    this.draft = null;
    this.nameField.value = '';
    this.render();
  }

  /** Writes the draft: a new note, or the saved one it was opened from. */
  private async save(): Promise<void> {
    const draft = this.draft;
    if (!draft || this.busy) return;
    const tEndMs = draft.tEndMs ?? Math.max(this.playheadMs, draft.tStartMs + MIN_SPAN_MS);
    const fields = { tStartMs: Math.round(draft.tStartMs), tEndMs: Math.round(tEndMs), text: this.nameField.value.trim() };
    this.busy = true;
    this.render();
    try {
      this.notations = draft.noteId
        ? await this.deps.notes.update(this.deps.recording.id, draft.noteId, fields)
        : await this.deps.notes.add(this.deps.recording.id, fields);
      this.draft = null;
      this.nameField.value = '';
      await this.section?.load();
    } catch {
      // The draft stays, so nothing typed is lost; the button can be pressed again.
    } finally {
      this.busy = false;
      this.render();
    }
  }

  /** Back to Details, and Done: a finished span is kept, not dropped on the way out. */
  private async leave(): Promise<void> {
    if (this.draft && (this.draft.tEndMs != null || this.draft.text.trim())) await this.save();
    this.deps.onDetails();
  }

  private seek(ms: number): void {
    const clamped = Math.max(0, Math.min(ms, this.durationMs || ms));
    if (this.playable) this.video.currentTime = clamped / 1000;
    this.setPlayhead(clamped);
  }

  private setPlayhead(ms: number): void {
    this.playheadMs = ms;
    this.paintTransport();
    this.paintStrip();
    // An open span follows the playhead, so what it covers grows as it plays.
    if (this.draft?.tEndMs == null && this.draft) { this.paintComposer(); this.paintLines(); }
  }

  private async togglePlay(): Promise<void> {
    if (!this.playable) return;
    if (this.video.paused) await this.video.play().catch(() => {});
    else this.video.pause();
  }

  // ─── Pointer and keys ───────────────────────────────────────────────────────

  private lineIndexAt(target: EventTarget | null): number | null {
    const row = (target as HTMLElement | null)?.closest?.<HTMLElement>('.note-editor__line');
    return row ? Number(row.dataset.index) : null;
  }

  private onLinesDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    const named = target.closest<HTMLElement>('.note-editor__note-name');
    if (named?.dataset.noteId) {
      // A saved note is edited only through its name, so it is never trimmed by accident.
      const note = this.notations.find((candidate) => candidate.id === named.dataset.noteId);
      if (note) this.startDraft({ tStartMs: note.tStartMs, tEndMs: note.tEndMs ?? note.tStartMs + MIN_SPAN_MS }, note);
      event.preventDefault();
      return;
    }
    const index = this.lineIndexAt(target);
    if (index == null) return;
    event.preventDefault();
    this.lineDrag = { from: index, moved: false };
  }

  private onLinesOver(event: MouseEvent): void {
    if (!this.lineDrag) return;
    const index = this.lineIndexAt(event.target);
    if (index == null || (index === this.lineDrag.from && !this.lineDrag.moved)) return;
    this.lineDrag.moved = true;
    const from = this.lines.findIndex((line) => line.index === this.lineDrag!.from);
    const to = this.lines.findIndex((line) => line.index === index);
    this.draft = { ...spanOfLines(this.lines, from, to), noteId: null, text: this.draft?.noteId ? '' : this.draft?.text ?? '' };
    this.render();
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.handleDrag || !this.draft || this.draft.tEndMs == null) return;
    const ms = seekFraction(event.clientX, this.scrub.getBoundingClientRect()) * this.durationMs;
    if (this.handleDrag === 'start') this.draft.tStartMs = Math.max(0, Math.min(ms, this.draft.tEndMs - MIN_SPAN_MS));
    else this.draft.tEndMs = Math.min(this.durationMs, Math.max(ms, this.draft.tStartMs + MIN_SPAN_MS));
    this.render();
    // The transcript keeps the line under the end being held in view.
    const at = this.handleDrag === 'start' ? this.draft.tStartMs : this.draft.tEndMs;
    const line = this.lineRows.get(activeSegmentIndex(this.segments, at));
    line?.scrollIntoView?.({ block: 'nearest' });
  }

  private onPointerUp(): void {
    if (this.handleDrag) {
      this.handleDrag = null;
      this.bubble.hidden = true;
      this.paintTimeline();
      this.nameField.focus();
    }
    if (!this.lineDrag) return;
    const { from, moved } = this.lineDrag;
    this.lineDrag = null;
    if (moved) { this.nameField.focus(); return; }
    // A click, not a drag: play from that line.
    const line = this.lines.find((candidate) => candidate.index === from);
    if (line) this.seek(line.segment.tStartMs);
  }

  private onKey(event: KeyboardEvent): void {
    const inField = (event.target as HTMLElement | null)?.tagName === 'INPUT';
    if (event.key === 'Escape' && !inField) {
      event.preventDefault();
      if (this.draft) this.discard();
      else void this.leave();
    } else if (event.key === ' ' && !inField) {
      event.preventDefault();
      void this.togglePlay();
    }
  }

  // ─── Painting ───────────────────────────────────────────────────────────────

  private render(): void {
    this.strip.hidden = !this.videoOn || !this.segments.length;
    this.videoChip.classList.toggle('note-editor__video-chip--on', this.videoOn);
    this.videoChip.setAttribute('aria-pressed', String(this.videoOn));
    this.duration.textContent = formatClock(this.durationMs);
    if (this.segments.length) {
      this.lines = editorLines(this.segments, this.notations);
      this.renderLines();
    } else {
      this.section?.setOpenSpan(this.openRow());
      this.empty.hidden = this.notations.length > 0 || Boolean(this.draft);
    }
    this.paintTransport();
    this.paintStrip();
    this.paintComposer();
    this.paintFooter();
  }

  /** The running span as the f6 list shows it, with its pencil and × wired back here. */
  private openRow() {
    if (!this.draft || this.draft.tEndMs != null) return null;
    return {
      tStartMs: this.draft.tStartMs,
      text: this.draft.text.trim(),
      onRename: () => this.nameField.focus(),
      onDiscard: () => this.discard(),
    };
  }

  private renderLines(): void {
    this.lineRows.clear();
    const rows = this.lines.map((line) => {
      const row = $('div', `note-editor__line${line.noteId ? ' note-editor__line--noted' : ''}`);
      row.dataset.index = String(line.index);
      const name = $('span', 'note-editor__note');
      if (line.noteName != null && line.noteId) {
        const label = $('button', `note-editor__note-name${line.noteName ? '' : ' note-editor__note-name--unnamed'}`);
        label.type = 'button';
        label.dataset.noteId = line.noteId;
        label.title = 'Edit this note’s range and name';
        label.textContent = line.noteName || 'Unnamed';
        name.append(label);
      }
      const gutter = $('span', 'note-editor__gutter');
      if (line.edge) gutter.dataset.edge = line.edge;
      const time = $('span', 'note-editor__time');
      time.textContent = formatClock(line.segment.tStartMs);
      const tag = $('span', 'note-editor__tag');
      tag.textContent = line.segment.speaker ?? '';
      if (line.segment.speaker) tag.title = line.segment.speaker;
      const text = $('span', 'note-editor__text');
      text.textContent = line.segment.text;
      row.append(name, gutter, time, tag, text);
      this.lineRows.set(line.index, row);
      return row;
    });
    this.linesHost.replaceChildren(...rows);
    this.paintLines();
  }

  /** The draft's run of lines: warmer than the page, its rail ticked rather than solid. */
  private paintLines(): void {
    if (!this.lines.length) return;
    const covered = this.draft ? linesInSpan(this.lines, this.draft, this.playheadMs) : new Set<number>();
    const ordered = this.lines.filter((line) => covered.has(line.index)).map((line) => line.index);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    for (const line of this.lines) {
      const row = this.lineRows.get(line.index);
      if (!row) continue;
      const inDraft = covered.has(line.index);
      row.classList.toggle('note-editor__line--draft', inDraft);
      row.classList.toggle('note-editor__line--draft-first', inDraft && line.index === first);
      row.classList.toggle('note-editor__line--draft-last', inDraft && line.index === last);
    }
  }

  private paintTransport(): void {
    const playing = this.playable && !this.video.paused;
    this.playButton.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    this.playButton.title = playing ? 'Pause' : 'Play from here';
    this.playButton.setAttribute('aria-label', this.playButton.title);
    this.playButton.disabled = !this.playable;
    if (!this.playable) this.playButton.title = 'This recording cannot be played here';
    this.clock.textContent = formatClock(this.playheadMs);
    const running = this.draft != null && this.draft.tEndMs == null;
    this.spanButton.classList.toggle('note-editor__span-button--end', running);
    this.spanButton.title = running ? 'End the open note' : 'Open a note at the playhead';
    this.spanButton.innerHTML = running ? '<span class="note-editor__stop" aria-hidden="true"></span>' : PLUS_ICON;
    this.spanButton.append(running ? 'END' : 'NOTE');
    // Still NOTE while a selection is open: pressing it trades the selection for a span at the playhead.
    this.spanButton.disabled = this.busy;
    this.paintTimeline();
  }

  private pct(ms: number): number {
    return this.durationMs > 0 ? Math.min(100, Math.max(0, (ms / this.durationMs) * 100)) : 0;
  }

  private paintTimeline(): void {
    const draft = this.draft;
    const marks = this.notations
      .filter((note) => note.id !== draft?.noteId)
      .map((note) => {
        const mark = $('span', `note-editor__mark${note.text ? '' : ' note-editor__mark--unnamed'}`);
        const end = note.tEndMs ?? note.tStartMs;
        mark.style.left = `${this.pct(note.tStartMs)}%`;
        mark.style.width = `max(3px, ${this.pct(end) - this.pct(note.tStartMs)}%)`;
        mark.title = `${formatSpan({ tStartMs: note.tStartMs, tEndMs: end })}${note.text ? ` · ${note.text}` : ''}`;
        return mark;
      });
    this.marks.replaceChildren(...marks);
    this.playhead.style.left = `${this.pct(this.playheadMs)}%`;

    this.draftMark.hidden = !draft;
    const trimmable = draft != null && draft.tEndMs != null;
    this.startHandle.hidden = !trimmable;
    this.endHandle.hidden = !trimmable;
    if (!draft) { this.bubble.hidden = true; return; }
    const end = draft.tEndMs ?? Math.max(this.playheadMs, draft.tStartMs);
    const left = this.pct(draft.tStartMs);
    const width = this.pct(end) - left;
    this.draftMark.style.left = `${left}%`;
    this.draftMark.style.width = `max(3px, ${width}%)`;
    this.draftMark.classList.toggle('note-editor__draft--running', draft.tEndMs == null);
    this.draftMark.title = draft.tEndMs == null ? `Open note, ${formatSpan(draft)}` : `New note, ${formatSpan(draft)}`;
    this.startHandle.style.left = `${left}%`;
    this.endHandle.style.left = `${left + width}%`;
    this.startHandle.classList.toggle('note-editor__handle--held', this.handleDrag === 'start');
    this.endHandle.classList.toggle('note-editor__handle--held', this.handleDrag === 'end');
    if (!this.bubble.hidden) {
      this.bubble.style.left = `${this.handleDrag === 'start' ? left : left + width}%`;
      const range = $('span');
      range.textContent = formatSpan(draft);
      const length = $('span', 'note-editor__bubble-length');
      length.textContent = formatLength(end - draft.tStartMs);
      this.bubble.replaceChildren(range, length);
    }
  }

  /** VIDEO (f5): the picture beside the line under the playhead. */
  private paintStrip(): void {
    if (this.strip.hidden) return;
    const segment = this.segments[activeSegmentIndex(this.segments, this.playheadMs)];
    this.stripTime.textContent = formatClock(this.playheadMs);
    this.stripTag.textContent = segment?.speaker ?? '';
    this.stripText.textContent = segment?.text ?? '';
  }

  private paintComposer(): void {
    const draft = this.draft;
    this.composer.hidden = !draft;
    if (!draft) return;
    const running = draft.tEndMs == null;
    this.composerRange.textContent = formatSpan(draft);
    const end = draft.tEndMs ?? Math.max(this.playheadMs, draft.tStartMs);
    this.composerLength.textContent = formatLength(end - draft.tStartMs);
    // An open span has only Discard; END is what keeps it (f6).
    this.cancelButton.textContent = running ? 'Discard' : 'Cancel';
    this.saveButton.hidden = running;
    this.saveButton.disabled = this.busy;
    this.nameField.disabled = this.busy;
  }

  private paintFooter(): void {
    const running = this.draft != null && this.draft.tEndMs == null;
    this.hint.textContent = running
      ? 'PRESS END TO CLOSE THE SPAN'
      : this.segments.length ? 'DRAG OVER LINES TO SET THE RANGE' : 'NOTE OPENS A SPAN AT THE PLAYHEAD';
    this.count.textContent = noteCount(this.notations.length, this.draft != null && this.draft.noteId == null);
  }
}
