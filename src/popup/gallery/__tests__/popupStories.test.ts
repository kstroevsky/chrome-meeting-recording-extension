import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderPopupPreview } from '../popupPreview';
import { POPUP_STORIES, popupStory } from '../popupStories';

const popupMarkup = readFileSync(resolve(process.cwd(), 'static/popup.html'), 'utf8');
const popupDocument = new DOMParser().parseFromString(popupMarkup, 'text/html');
const popupBody = popupDocument.body.innerHTML;
const POPUP_VIEW_IDS = [
  'view-config',
  'view-permission',
  'view-recording',
  'view-finalizing',
  'view-interrupted',
  'view-upload',
  'view-recordings',
  'view-recording-detail',
] as const;

describe('popup gallery stories', () => {
  test('story ids are unique and resolve from the catalogue', () => {
    const ids = POPUP_STORIES.map((story) => story.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const story of POPUP_STORIES) expect(popupStory(story.id)).toBe(story);
  });

  test('stories are deterministic domain fixtures, not DOM mutation callbacks', () => {
    for (const story of POPUP_STORIES) {
      expect(story.preview).toBeDefined();
      expect((story as unknown as Record<string, unknown>).apply).toBeUndefined();
      // Layout comes from the real popup markup. A gallery-only height floor
      // would move fixed overlays away from their production position.
      expect((story as unknown as Record<string, unknown>).minHeight).toBeUndefined();
      expect(story.title).not.toHaveLength(0);
      expect(story.description).not.toHaveLength(0);
    }
  });

  test.each(POPUP_STORIES.map((story) => [story.id] as const))(
    '%s boots through the real popup controller against current popup markup',
    (storyId) => {
      document.body.innerHTML = popupBody;
      renderPopupPreview(storyId, document);

      expect(document.querySelector('.gallery-preview-error')).toBeNull();
      expect(document.documentElement.dataset.popupStory).toBe(storyId);
      const visibleViews = POPUP_VIEW_IDS.filter((viewId) => !document.getElementById(viewId)?.hidden);
      expect(visibleViews).toHaveLength(1);
    },
  );

  test('keeps safe preview controls interactive while marking runtime actions inert', () => {
    document.body.innerHTML = popupBody;
    renderPopupPreview('device-picker', document);
    const picker = document.getElementById('device-picker')!;
    expect(picker.hidden).toBe(false);
    document.getElementById('device-picker-close')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picker.hidden).toBe(true);

    document.body.innerHTML = popupBody;
    renderPopupPreview('setup-default', document);
    const captureToggle = document.getElementById('toggle-capture-setup')!;
    captureToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.getElementById('capture-details')!.hidden).toBe(false);

    const start = document.getElementById('start-rec')!;
    expect(start.dataset.previewActionBlocked).toBe('true');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    start.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

  });
});
