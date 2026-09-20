/**
 * These names are produced in one place and parsed in another, and the two
 * drifted apart twice: the slug stopped being `google-meet-…` and became
 * `meet-{code}` or the page's own title, and the stamp gained seconds. The
 * parser kept demanding the old shape and matched nothing it was given, so
 * orphan recovery found no recordings and every Drive folder was named after
 * the moment of upload.
 *
 * The tests that should have caught it wrote the filename out by hand, in a
 * shape nothing produced. So these build the name with the real builder, and
 * use the slugs `RecordingController.resolveMeetingSlug` really returns:
 * `meet-{code}` for a Meet tab, a title-derived slug elsewhere, and an empty
 * one for a page with no usable title.
 */
import { buildRecordingFilename } from '../../engine/RecorderTaskUtils';
import {
  inferDriveRecordingFolderName,
  isRecordingFilename,
  retitleRecordingFilename,
} from '../folderNaming';

/** Exactly what the slug resolver returns, for each kind of tab it handles. */
const REAL_SLUGS = ['meet-abc-defg-hij', 'my-page-title-github', ''] as const;
const built = (slug: string, stream: 'tab' | 'mic' | 'self-video' = 'tab') =>
  buildRecordingFilename(slug, stream, 'webm');

describe('the names this extension actually produces', () => {
  it.each(REAL_SLUGS)('are recognised as its own (slug: %s)', (slug) => {
    expect(isRecordingFilename(built(slug))).toBe(true);
    expect(isRecordingFilename(built(slug, 'mic'))).toBe(true);
    expect(isRecordingFilename(built(slug, 'self-video'))).toBe(true);
  });

  it.each(REAL_SLUGS)('give every file of one recording the same folder (slug: %s)', (slug) => {
    const folder = inferDriveRecordingFolderName(built(slug));
    expect(inferDriveRecordingFolderName(built(slug, 'mic'))).toBe(folder);
    // Named after the meeting, not after whenever the question was asked.
    expect(folder).not.toMatch(/^google-meet-\d{8}T\d{4}$/);
    if (slug) expect(folder.startsWith(`${slug}-`)).toBe(true);
    else expect(folder).toMatch(/^\d{8}T\d{6}$/);
  });

  it('can be retitled without losing the datetime the folder is keyed on', () => {
    const original = built('meet-abc-defg-hij');
    const retitled = retitleRecordingFilename(original, 'team-sync');
    expect(retitled).not.toBeNull();
    expect(isRecordingFilename(retitled!)).toBe(true);
    expect(inferDriveRecordingFolderName(retitled!))
      .toBe(inferDriveRecordingFolderName(original).replace('meet-abc-defg-hij', 'team-sync'));
  });

  it('still reads the names earlier versions wrote', () => {
    // Minute-only stamp, and the `google-meet-` slug from before the rename.
    const legacy = 'google-meet-abc-20260101T0900-recording.webm';
    expect(isRecordingFilename(legacy)).toBe(true);
    expect(inferDriveRecordingFolderName(legacy)).toBe('google-meet-abc-20260101T0900');
  });

  it('does not claim a name it did not produce', () => {
    expect(isRecordingFilename('holiday-video.webm')).toBe(false);
    expect(isRecordingFilename('meet-abc-20260101T090000-notes.vtt')).toBe(false);
    expect(isRecordingFilename('meet-abc-recording.webm')).toBe(false);
  });
});
