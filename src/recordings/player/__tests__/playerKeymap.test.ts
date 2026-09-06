/** Design card f19: the map, and the rule that makes single keys safe. */
import {
  KEYBOARD_HELP,
  adjacentNoteStart,
  isFieldTarget,
  nextSpeed,
  resolvePlayerAction,
  SPEED_STEPS,
} from '../playerKeymap';

describe('resolvePlayerAction', () => {
  it('maps transport keys', () => {
    expect(resolvePlayerAction({ key: ' ' })).toEqual({ kind: 'play-pause' });
    expect(resolvePlayerAction({ key: 'ArrowRight' })).toEqual({ kind: 'skip', seconds: 10 });
    expect(resolvePlayerAction({ key: 'ArrowLeft' })).toEqual({ kind: 'skip', seconds: -10 });
    expect(resolvePlayerAction({ key: 'ArrowUp' })).toEqual({ kind: 'volume', direction: 1 });
    expect(resolvePlayerAction({ key: 'ArrowDown' })).toEqual({ kind: 'volume', direction: -1 });
  });

  it('maps the letter keys, in either case', () => {
    expect(resolvePlayerAction({ key: 'j' })).toEqual({ kind: 'speed', direction: -1 });
    expect(resolvePlayerAction({ key: 'L' })).toEqual({ kind: 'speed', direction: 1 });
    expect(resolvePlayerAction({ key: 'm' })).toEqual({ kind: 'mute' });
    expect(resolvePlayerAction({ key: 'F' })).toEqual({ kind: 'fullscreen' });
  });

  it('walks notes forward, and backward with shift', () => {
    expect(resolvePlayerAction({ key: 'n' })).toEqual({ kind: 'note', direction: 1 });
    expect(resolvePlayerAction({ key: 'N', shiftKey: true })).toEqual({ kind: 'note', direction: -1 });
  });

  it('honours a configured skip step', () => {
    expect(resolvePlayerAction({ key: 'ArrowRight' }, { skipSeconds: 30 })).toEqual({ kind: 'skip', seconds: 30 });
  });

  /**
   * The rule the whole map depends on: without it, typing a note name would
   * mute, skip and jump between notes.
   */
  describe('while a field has focus', () => {
    const inField = { inField: true };

    it('swallows every bare letter and arrow', () => {
      for (const key of ['m', 'f', 'j', 'l', 'n', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
        expect(resolvePlayerAction({ key }, inField)).toBeNull();
      }
    });

    it('still lets Escape out', () => {
      expect(resolvePlayerAction({ key: 'Escape' }, inField)).toEqual({ kind: 'escape' });
    });
  });

  it('ignores anything carrying a browser or OS modifier', () => {
    expect(resolvePlayerAction({ key: 'm', metaKey: true })).toBeNull();
    expect(resolvePlayerAction({ key: 'f', ctrlKey: true })).toBeNull();
    expect(resolvePlayerAction({ key: 'ArrowRight', altKey: true })).toBeNull();
    // Shift is part of the map, not a disqualifier.
    expect(resolvePlayerAction({ key: 'N', shiftKey: true })).not.toBeNull();
  });

  it('opens the map on ?', () => {
    expect(resolvePlayerAction({ key: '?' })).toEqual({ kind: 'help' });
    // Still a bare key: a field must swallow it.
    expect(resolvePlayerAction({ key: '?' }, { inField: true })).toBeNull();
  });

  it('ignores keys it does not own', () => {
    expect(resolvePlayerAction({ key: 'q' })).toBeNull();
    expect(resolvePlayerAction({ key: 'Tab' })).toBeNull();
  });
});

describe('isFieldTarget', () => {
  it('recognises the elements that swallow letters', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isFieldTarget(document.createElement(tag))).toBe(true);
    }
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom does not derive isContentEditable, so assert the property directly.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isFieldTarget(editable)).toBe(true);
  });

  it('is false for the player chrome and for nothing at all', () => {
    expect(isFieldTarget(document.createElement('button'))).toBe(false);
    expect(isFieldTarget(null)).toBe(false);
  });
});

describe('nextSpeed', () => {
  it('steps along the ladder and stops at both ends', () => {
    expect(nextSpeed(1, 1)).toBe(1.25);
    expect(nextSpeed(1, -1)).toBe(0.75);
    expect(nextSpeed(SPEED_STEPS[SPEED_STEPS.length - 1], 1)).toBe(2);
    expect(nextSpeed(SPEED_STEPS[0], -1)).toBe(0.5);
  });

  it('snaps an off-ladder rate back to normal rather than jumping', () => {
    expect(nextSpeed(1.37, 1)).toBe(1);
  });
});

describe('adjacentNoteStart', () => {
  const starts = [5_000, 20_000, 60_000];

  it('finds the next and previous note', () => {
    expect(adjacentNoteStart(starts, 10_000, 1)).toBe(20_000);
    expect(adjacentNoteStart(starts, 30_000, -1)).toBe(20_000);
  });

  it('returns nothing past either end', () => {
    expect(adjacentNoteStart(starts, 90_000, 1)).toBeNull();
    expect(adjacentNoteStart(starts, 0, -1)).toBeNull();
  });

  it('does not stick on the note it is already sitting on', () => {
    // Landing exactly on a note and pressing N again must move on.
    expect(adjacentNoteStart(starts, 20_000, 1)).toBe(60_000);
    expect(adjacentNoteStart(starts, 20_000, -1)).toBe(5_000);
  });

  it('sorts unordered input', () => {
    expect(adjacentNoteStart([60_000, 5_000, 20_000], 0, 1)).toBe(5_000);
  });
});

describe('KEYBOARD_HELP', () => {
  it('documents every action the resolver can produce', () => {
    const documented = KEYBOARD_HELP.map((row) => row.keys).join(' ');
    for (const fragment of ['Space', '←', 'J', 'M', '↑', 'N', 'F', '?', 'Esc']) {
      expect(documented).toContain(fragment);
    }
  });
});
