/**
 * @file popup/notes/notationRibbon.ts
 *
 * Draws notation spans onto a track.
 *
 * Three surfaces show the same ribbon against three different clocks — the live
 * recording (scaled to elapsed time with headroom), a finished recording
 * (scaled to its own duration), and a run that was interrupted (scaled to where
 * capture stopped). Only the clock differs, so the placement rule, the state
 * classes and the span's label live here rather than once per screen.
 *
 * What genuinely varies is named in {@link NotationRibbonOptions} and
 * {@link NotationRibbonView}: the scale, where an open span is drawn to, the
 * smallest span the track will show, and whether spans are clickable.
 */

import { formatPosition } from '../popupStatus';
import type { RecordingNotation } from '../../shared/notations';

export type NotationRibbonOptions = {
  /** Class on every span. The finished and live ribbons are styled apart. */
  spanClass: string;
  /**
   * Smallest span the ribbon will draw, in percent of the track. A finished
   * ribbon uses a floor so a point mark stays visible; the live ribbon uses 0
   * and lets `min-width` in CSS do it, so a just-started span grows from
   * nothing rather than jumping to a floor.
   */
  minWidthPct?: number;
  /** Class marking the span the surface is currently acting on. */
  activeClass?: string;
  /** Present = spans are buttons reporting clicks. Absent = inert spans. */
  onSelect?: (id: string) => void;
};

export type NotationRibbonView = {
  /** Milliseconds the full width of the track represents. */
  scaleMs: number;
  /** Where a span with no end is drawn to. Defaults to its own start. */
  openEndsAtMs?: number;
  /** The span to mark with {@link NotationRibbonOptions.activeClass}. */
  activeId?: string | null;
};

/** "0:41 → 1:18 · Q3 target changed" — a span's only label. */
export function describeNotation(notation: RecordingNotation): string {
  const range = notation.tEndMs == null
    ? `${formatPosition(notation.tStartMs)} → …`
    : `${formatPosition(notation.tStartMs)} → ${formatPosition(notation.tEndMs)}`;
  return notation.text ? `${range} · ${notation.text}` : range;
}

/** What was last written to a span, so a redraw only touches what moved. */
type Painted = { identity: string; left: string; width: string };

export class NotationRibbon {
  private readonly spans = new Map<string, HTMLElement>();
  /**
   * The ribbon repaints every second for the whole run. Only the geometry
   * changes on a tick — classes and labels follow the notation — so each is
   * written only when its own input changed. At the 500-note cap that is two
   * style writes per span instead of eight DOM operations.
   */
  private readonly painted = new WeakMap<HTMLElement, Painted>();

  constructor(
    private readonly track: HTMLElement,
    private readonly options: NotationRibbonOptions,
  ) {}

  /**
   * Reconciles the track's spans in place, so a click target survives a redraw
   * — the live ribbon repaints once a second while the user is aiming at one.
   *
   * Only elements this ribbon created are touched, so a surface may keep its
   * own children (a playhead, a selection marker) in the same track.
   */
  draw(notations: RecordingNotation[], view: NotationRibbonView): void {
    const drawn = new Set<string>();
    for (const notation of notations) {
      drawn.add(notation.id);
      this.place(this.spanFor(notation), notation, view);
    }
    for (const [id, span] of this.spans) {
      if (drawn.has(id)) continue;
      span.remove();
      this.spans.delete(id);
    }
  }

  /** Drops every span this ribbon drew. */
  clear(): void {
    for (const span of this.spans.values()) span.remove();
    this.spans.clear();
  }

  private spanFor(notation: RecordingNotation): HTMLElement {
    const existing = this.spans.get(notation.id);
    if (existing) return existing;

    const { onSelect } = this.options;
    const span = document.createElement(onSelect ? 'button' : 'span');
    if (span instanceof HTMLButtonElement) {
      span.type = 'button';
      span.addEventListener('click', () => onSelect?.(notation.id));
    }
    this.track.appendChild(span);
    this.spans.set(notation.id, span);
    return span;
  }

  private place(span: HTMLElement, notation: RecordingNotation, view: NotationRibbonView): void {
    const scale = Math.max(view.scaleMs, 1);
    const end = notation.tEndMs ?? view.openEndsAtMs ?? notation.tStartMs;
    // Clamp the start first, so the remaining track is never negative.
    const left = Math.min(100, Math.max(0, (notation.tStartMs / scale) * 100));
    const width = Math.max(
      this.options.minWidthPct ?? 0,
      Math.min(100 - left, ((end - notation.tStartMs) / scale) * 100),
    );
    const leftPct = `${left}%`;
    const widthPct = `${Math.max(0, width)}%`;

    const active = this.options.activeClass != null && view.activeId === notation.id;
    const identity = `${notation.tEndMs ?? ''}|${notation.endedBy ?? ''}|${active}|${notation.text}`;
    const last = this.painted.get(span);

    if (last?.identity !== identity) {
      // Assigned rather than toggled, so the class set is exactly what this
      // ribbon decides regardless of what a previous draw left behind.
      span.className = this.options.spanClass;
      span.classList.toggle('open', notation.tEndMs == null);
      // A note the run sealed on the way out reads as muted: it ended because
      // the recording did, not because the user closed it.
      span.classList.toggle('auto-ended', notation.endedBy === 'auto');
      if (this.options.activeClass) span.classList.toggle(this.options.activeClass, active);
      const label = describeNotation(notation);
      span.title = label;
      span.setAttribute('aria-label', label);
    }
    if (last?.left !== leftPct) span.style.left = leftPct;
    if (last?.width !== widthPct) span.style.width = widthPct;

    this.painted.set(span, { identity, left: leftPct, width: widthPct });
  }
}
