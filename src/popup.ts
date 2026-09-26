/**
 * @context Extension popup (browser_action page)
 * @role Starts the production popup, or a deterministic development preview.
 *
 * The document map and shell wiring deliberately live in focused modules so the
 * gallery exercises exactly the same popup contract as a real extension popup.
 */

import { createPopupController } from './popup/popupBootstrap';
import { wirePopupShell } from './popup/popupShell';
import { isDevBuild } from './shared/build';
import { initializeExtensionTheme } from './shared/theme';
import { trackFocusSource } from './ui/focusSource';

const previewStoryId = __POPUP_GALLERY_BUILD__ && isDevBuild()
  ? new URLSearchParams(location.search).get('popupPreview')
  : null;

trackFocusSource();

if (previewStoryId) {
  // Gallery iframes load the real popup document. They replace only external
  // Chrome state with a fixture; CSS and all rendering stay production-owned.
  document.documentElement.dataset.popupPreview = 'true';
  void import('./popup/gallery/popupPreview').then(({ renderPopupPreview }) => renderPopupPreview(previewStoryId));
} else {
  initializeExtensionTheme();
  wirePopupShell();
  const controller = createPopupController();
  controller.init();
}
