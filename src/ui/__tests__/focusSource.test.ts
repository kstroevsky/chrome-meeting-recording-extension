/**
 * The mark decides whether a page shows focus rings, so when it is set and
 * cleared is the whole contract.
 */
import { trackFocusSource } from '../focusSource';

const source = () => document.documentElement.dataset.focusSource;
const key = (name: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));

beforeAll(() => trackFocusSource(document));
beforeEach(() => {
  delete document.documentElement.dataset.focusSource;
  document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>';
});

describe('focus source', () => {
  it('marks a pointer press, and a shortcut key afterwards keeps the mark', () => {
    document.getElementById('a')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.getElementById('a')!.focus();
    expect(source()).toBe('pointer');
    key(' ');
    key('m');
    expect(source()).toBe('pointer');
  });

  it('clears the mark on Tab', () => {
    document.dispatchEvent(new Event('pointerdown'));
    key('Tab');
    expect(source()).toBeUndefined();
  });

  it('clears the mark when a key moves focus, as arrows do in a list', () => {
    document.dispatchEvent(new Event('pointerdown'));
    document.getElementById('a')!.focus();
    key('ArrowDown');
    document.getElementById('b')!.focus();
    expect(source()).toBeUndefined();
  });

  it('keeps the mark when a click moves focus on its own', () => {
    document.dispatchEvent(new Event('pointerdown'));
    document.getElementById('b')!.focus();
    expect(source()).toBe('pointer');
  });
});
