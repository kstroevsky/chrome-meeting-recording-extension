import { ModalShell } from '../modalShell';

describe('ModalShell', () => {
  let shell: ModalShell;
  let onDismiss: jest.Mock;

  const key = (k: string, init: KeyboardEventInit = {}) =>
    shell.overlay.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

  beforeEach(() => {
    document.body.replaceChildren();
    onDismiss = jest.fn();
    shell = new ModalShell({ idPrefix: 'test-modal', onDismiss });
  });

  it('wires the card to its title and message for assistive tech', () => {
    expect(shell.card.getAttribute('role')).toBe('dialog');
    expect(shell.card.getAttribute('aria-modal')).toBe('true');
    expect(shell.card.getAttribute('aria-labelledby')).toBe(shell.title.id);
    expect(shell.card.getAttribute('aria-describedby')).toBe(shell.message.id);
    expect(shell.title.id).toBe('test-modal-title');
  });

  it('starts hidden and restores focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    expect(shell.isOpen).toBe(false);

    const inner = document.createElement('button');
    shell.body.append(inner);
    shell.open(inner);
    expect(shell.isOpen).toBe(true);
    expect(document.activeElement).toBe(inner);

    shell.close();
    expect(shell.isOpen).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('dismisses on Escape and on the scrim, but never on the card', () => {
    shell.open();
    key('Escape');
    expect(onDismiss).toHaveBeenCalledTimes(1);

    shell.overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(2);

    shell.card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('ignores dismissal while locked, so a save in flight cannot be cancelled', () => {
    shell.open();
    shell.setLocked(true);
    key('Escape');
    shell.overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();

    shell.setLocked(false);
    key('Escape');
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('wraps Tab at both edges of the card', () => {
    const first = document.createElement('button');
    const middle = document.createElement('input');
    const last = document.createElement('button');
    shell.body.append(first, middle);
    shell.actions.append(last);
    shell.open(first);

    last.focus();
    key('Tab');
    expect(document.activeElement).toBe(first);

    first.focus();
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('re-reads the focusable set, so a control that appears joins the trap', () => {
    const first = document.createElement('button');
    const optional = document.createElement('button');
    const hidden = document.createElement('div');
    hidden.hidden = true;
    hidden.append(optional);
    shell.body.append(first, hidden);
    shell.open(first);

    // While its wrapper is hidden, the last stop is still the first button.
    first.focus();
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(first);

    hidden.hidden = false;
    first.focus();
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(optional);
  });

  it('skips disabled controls when wrapping', () => {
    const first = document.createElement('button');
    const disabled = document.createElement('button');
    disabled.disabled = true;
    const last = document.createElement('button');
    shell.body.append(first, last, disabled);
    shell.open(first);

    first.focus();
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('removes its DOM on destroy', () => {
    expect(shell.overlay.isConnected).toBe(true);
    shell.destroy();
    expect(shell.overlay.isConnected).toBe(false);
  });
});
