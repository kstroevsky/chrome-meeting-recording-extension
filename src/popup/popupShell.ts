/** Popup chrome that surrounds controller-owned views (menu and setup controls). */

import { createRuntimeTab } from '../platform/chrome/tabs';
import { isDevBuild } from '../shared/build';
import type { PopupPreviewShellState } from './popupPreviewState';
import { bindListbox } from '../ui/listboxSelect';

const byId = <T extends HTMLElement>(doc: Document, id: string): T | null =>
  doc.getElementById(id) as T | null;

export type PopupShell = {
  applyPreview(state?: PopupPreviewShellState): void;
};

/** Wires production shell interactions and exposes only semantic preview controls. */
export function wirePopupShell(doc: Document = document): PopupShell {
  const menuButton = byId<HTMLButtonElement>(doc, 'open-menu');
  const menu = byId<HTMLElement>(doc, 'popup-menu');
  const setMenuOpen = (open: boolean) => {
    if (!menuButton || !menu) return;
    menu.hidden = !open;
    menuButton.setAttribute('aria-expanded', String(open));
  };
  if (menuButton && menu) {
    menuButton.addEventListener('click', () => setMenuOpen(menu.hidden));
    doc.addEventListener('click', (event) => {
      if (!menu.hidden && !menu.contains(event.target as Node) && !menuButton.contains(event.target as Node)) setMenuOpen(false);
    });
    menu.addEventListener('click', () => setMenuOpen(false));
    doc.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenuOpen(false); });
  }

  const popupGalleryButton = byId<HTMLButtonElement>(doc, 'open-popup-gallery');
  if (popupGalleryButton && isDevBuild()) {
    popupGalleryButton.hidden = false;
    popupGalleryButton.addEventListener('click', () => void createRuntimeTab('popup-gallery.html'));
  }

  /**
   * The two static dropdowns keep their markup in popup.html; the behaviour is
   * `ui/listboxSelect`'s, so a keyboard fix lands here and on the destination
   * pickers at once. Storage mode additionally mirrors the chosen option's icon
   * into the trigger, which is why it passes onSync.
   */
  const wireSelect = (selectId: string, triggerId: string, optionsId: string, withIcon = false): void => {
    const select = byId<HTMLSelectElement>(doc, selectId);
    const trigger = byId<HTMLButtonElement>(doc, triggerId);
    const list = byId<HTMLElement>(doc, optionsId);
    if (!select || !trigger || !list) return;
    bindListbox({ select, trigger, list, doc }, {
      onSync: withIcon ? ({ select: source, trigger: button, list: options }) => {
        const selectedIcon = options.querySelector<SVGElement>(`[role="option"][data-value="${source.value}"] svg`);
        const currentIcon = button.querySelector<SVGElement>('svg');
        if (!selectedIcon || !currentIcon) return;
        const icon = selectedIcon.cloneNode(true) as SVGElement;
        icon.classList.add('select-storage-icon');
        currentIcon.replaceWith(icon);
      } : undefined,
    });
  };

  wireSelect('storage-mode', 'storage-mode-trigger', 'storage-mode-options', true);
  wireSelect('mic-mode', 'mic-mode-trigger', 'mic-mode-options');

  const captureToggle = byId<HTMLButtonElement>(doc, 'toggle-capture-setup');
  const captureDetails = byId<HTMLElement>(doc, 'capture-details');
  const captureSummary = byId<HTMLElement>(doc, 'capture-summary-value');
  const syncCaptureSummary = () => {
    const mic = byId<HTMLSelectElement>(doc, 'mic-mode')?.value ?? 'separate';
    const cameraOn = byId<HTMLInputElement>(doc, 'record-self-video')?.checked ?? false;
    if (captureSummary) captureSummary.textContent = `CAM ${cameraOn ? 'ON' : 'OFF'} · MIC ${mic.toUpperCase()} · 720P`;
  };
  const setCaptureDetailsExpanded = (expanded: boolean) => {
    if (!captureToggle || !captureDetails) return;
    captureToggle.setAttribute('aria-expanded', String(expanded));
    captureDetails.hidden = !expanded;
  };
  if (captureToggle && captureDetails) {
    captureToggle.addEventListener('click', () => setCaptureDetailsExpanded(captureToggle.getAttribute('aria-expanded') !== 'true'));
    ['mic-mode', 'record-self-video'].forEach((id) => byId<HTMLInputElement | HTMLSelectElement>(doc, id)?.addEventListener('change', syncCaptureSummary));
    doc.querySelectorAll<HTMLInputElement>('input[name="tab-content-type"]').forEach((input) => input.addEventListener('change', syncCaptureSummary));
    syncCaptureSummary();
  }

  return {
    applyPreview(state) {
      if (!state) return;
      if (state.menuOpen != null) setMenuOpen(state.menuOpen);
      if (state.captureDetailsExpanded != null) setCaptureDetailsExpanded(state.captureDetailsExpanded);
    },
  };
}
