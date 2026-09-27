/**
 * @file ui/focusSource.ts
 *
 * Keeps focus rings for the keyboard.
 *
 * Clicking a button focuses it without a ring, but Chrome shows the ring the
 * moment any key is pressed while it holds focus. So a shortcut pressed after a
 * click — Space in the player — rings whatever was clicked last, far from
 * anything the user is doing.
 *
 * The page records how focus last arrived instead. A pointer press marks the
 * root `data-focus-source="pointer"`, and each page's stylesheet hides its
 * rings under that mark. Focus moved by the keyboard (Tab, or arrows walking a
 * list) clears it, so someone navigating by keyboard always sees where they are.
 */
export function trackFocusSource(doc: Document = document): void {
  const root = doc.documentElement;
  let lastInput: 'pointer' | 'key' = 'key';
  doc.addEventListener('pointerdown', () => {
    lastInput = 'pointer';
    root.dataset.focusSource = 'pointer';
  }, true);
  doc.addEventListener('keydown', (event) => {
    lastInput = 'key';
    if (event.key === 'Tab') delete root.dataset.focusSource;
  }, true);
  // A key that moves focus (arrows in a listbox) is navigation, not a shortcut.
  doc.addEventListener('focusin', () => {
    if (lastInput === 'key') delete root.dataset.focusSource;
  }, true);
}
