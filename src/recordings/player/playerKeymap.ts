/**
 * @file recordings/player/playerKeymap.ts
 *
 * The player's keyboard map (design card `f19`), resolved as data so the one
 * rule that makes single-key shortcuts safe can be tested directly:
 *
 *   **Bare letters never fire while a field has focus.** Only Escape and Enter
 *   act there.
 *
 * Without that rule, typing a name into a rename field would toggle mute, skip
 * the video and jump between notes. It is the reason the rest of the map can be
 * unmodified single keys at all.
 */

export type PlayerAction =
  | { kind: 'play-pause' }
  | { kind: 'skip'; seconds: number }
  | { kind: 'speed'; direction: -1 | 1 }
  | { kind: 'volume'; direction: -1 | 1 }
  | { kind: 'mute' }
  | { kind: 'note'; direction: -1 | 1 }
  | { kind: 'fullscreen' }
  | { kind: 'help' }
  | { kind: 'escape' };

/** The parts of a keyboard event this needs. */
export type KeyLike = {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

export type KeymapOptions = {
  /** Seconds moved by ←/→. The design offers 5/10/30; 10 is the default. */
  skipSeconds?: number;
  /** True when focus is in a text field, select, or contenteditable. */
  inField?: boolean;
};

/** True for a target that swallows bare letters. */
export function isFieldTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') return false;
  if (element.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}

export function resolvePlayerAction(event: KeyLike, options: KeymapOptions = {}): PlayerAction | null {
  // A shortcut with a modifier belongs to the browser or the OS, not to us.
  // Shift is the exception: it is part of the map (⇧N).
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  // Escape always acts, in a field or not — it is how you get out of one.
  if (event.key === 'Escape') return { kind: 'escape' };
  if (options.inField) return null;

  // `?` is shifted on most layouts, so match the character rather than the key.
  if (event.key === '?') return { kind: 'help' };

  const skip = options.skipSeconds ?? 10;
  switch (event.key) {
    case ' ':
    case 'Spacebar': return { kind: 'play-pause' };
    case 'ArrowLeft': return { kind: 'skip', seconds: -skip };
    case 'ArrowRight': return { kind: 'skip', seconds: skip };
    case 'ArrowUp': return { kind: 'volume', direction: 1 };
    case 'ArrowDown': return { kind: 'volume', direction: -1 };
    default: break;
  }

  switch (event.key.toLowerCase()) {
    case 'j': return { kind: 'speed', direction: -1 };
    case 'l': return { kind: 'speed', direction: 1 };
    case 'm': return { kind: 'mute' };
    case 'f': return { kind: 'fullscreen' };
    case 'n': return { kind: 'note', direction: event.shiftKey ? -1 : 1 };
    default: return null;
  }
}

/** Speeds the player steps through, in order. */
export const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export function nextSpeed(current: number, direction: -1 | 1): number {
  const index = SPEED_STEPS.indexOf(current as (typeof SPEED_STEPS)[number]);
  // An off-ladder rate (set elsewhere) snaps to normal rather than jumping wildly.
  if (index === -1) return 1;
  return SPEED_STEPS[Math.min(SPEED_STEPS.length - 1, Math.max(0, index + direction))];
}

/**
 * The note to jump to from `positionMs`. Forward finds the first note that
 * starts later; backward finds the last that starts earlier, so repeated
 * presses walk the list rather than sticking on the current one.
 */
export function adjacentNoteStart(
  starts: readonly number[],
  positionMs: number,
  direction: -1 | 1,
): number | null {
  const sorted = [...starts].sort((a, b) => a - b);
  if (direction === 1) return sorted.find((start) => start > positionMs + 250) ?? null;
  for (let i = sorted.length - 1; i >= 0; i -= 1) if (sorted[i] < positionMs - 250) return sorted[i];
  return null;
}

/** Skip steps the settings menu offers, in seconds. */
export const SKIP_STEPS = [5, 10, 30] as const;

/** The map, as rendered by the `?` overlay. Kept beside the resolver so the
 *  two cannot describe different keyboards. */
export const KEYBOARD_HELP: ReadonlyArray<{ keys: string; description: string }> = [
  { keys: 'Space', description: 'Play or pause' },
  { keys: '← / →', description: 'Skip back or forward' },
  { keys: 'J / L', description: 'Slower or faster' },
  { keys: 'M', description: 'Mute every track' },
  { keys: '↑ / ↓', description: 'Volume' },
  { keys: 'N / ⇧N', description: 'Next or previous note' },
  { keys: 'F', description: 'Fullscreen' },
  { keys: '?', description: 'This map' },
  { keys: 'Esc', description: 'Leave fullscreen, then close' },
];
