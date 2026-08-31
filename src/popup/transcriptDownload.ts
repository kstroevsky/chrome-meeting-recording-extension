/**
 * @file popup/transcriptDownload.ts
 *
 * Saves the captions the content script has accumulated on the meeting tab.
 *
 * This is the one popup action that does not go through the background at all:
 * the transcript lives in the page, so the popup asks the tab directly and
 * hands the bytes to the download API itself. It is also independent of the
 * recording — a transcript can be saved without ever having recorded anything.
 */

import { buildTranscriptFilename, POPUP_TOAST_TEXT } from './popupMessages';
import { downloadFile } from '../platform/chrome/downloads';
import { queryActiveTab } from '../platform/chrome/tabs';
import { sendToContent } from '../shared/messages';

/** Wires the save button, if the popup has one. */
export function wireTranscriptDownload(
  saveBtn: HTMLButtonElement | null | undefined,
  notify: (message: string) => void,
): void {
  if (!saveBtn) return;
  saveBtn.addEventListener('click', () => void saveTranscript(notify));
}

async function saveTranscript(notify: (message: string) => void): Promise<void> {
  const tab = await queryActiveTab();
  if (!tab?.id) return;

  // A tab with no content script answers nothing; that is not an error, it just
  // means there is no meeting there to transcribe.
  const res = await sendToContent(tab.id, { type: 'GET_TRANSCRIPT' }).catch(() => {
    notify(POPUP_TOAST_TEXT.noTranscriptOnPage);
    return undefined;
  });

  const transcript = res?.transcript;
  if (!transcript?.trim()) {
    notify(POPUP_TOAST_TEXT.transcriptEmpty);
    return;
  }

  const blob = new Blob([transcript], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const suffix = res?.provider.meetingId || 'google-meet';

  try {
    await downloadFile({ url, filename: buildTranscriptFilename(suffix), saveAs: true });
  } finally {
    URL.revokeObjectURL(url);
  }
}
