/** User-named Drive destinations: sanitised, because a name becomes a folder. */
import { normalizeExtensionSettings } from '../normalize';
import { MAX_DRIVE_FOLDER_NAME_LENGTH, MAX_DRIVE_FOLDER_PRESETS } from '../defaults';

const withStorage = (storage: unknown) => normalizeExtensionSettings({ storage }).storage;
const preset = (id: string, name: string) => ({ id, name });

describe('drive folder presets', () => {
  it('defaults to none, which is the pre-presets behaviour', () => {
    expect(normalizeExtensionSettings({}).storage).toEqual({ driveFolderPresets: [] });
  });

  it('keeps well-formed destinations in order', () => {
    expect(withStorage({
      driveFolderPresets: [preset('a', 'Work meetings'), preset('b', 'Psychotherapy'), preset('c', 'Interviews')],
    }).driveFolderPresets).toEqual([
      { id: 'a', name: 'Work meetings' },
      { id: 'b', name: 'Psychotherapy' },
      { id: 'c', name: 'Interviews' },
    ]);
  });

  it('trims and collapses whitespace, because the name becomes a folder name', () => {
    expect(withStorage({ driveFolderPresets: [preset('a', '  Work   meetings  ')] })
      .driveFolderPresets[0].name).toBe('Work meetings');
  });

  it('strips path separators and control characters', () => {
    // A slash reads as a path and is not one.
    expect(withStorage({ driveFolderPresets: [preset('a', 'Work/Personal')] })
      .driveFolderPresets[0].name).toBe('Work Personal');
    expect(withStorage({ driveFolderPresets: [preset('a', 'Bad\u0007name')] })
      .driveFolderPresets[0].name).toBe('Bad name');
  });

  it('drops a destination with no usable name or no id', () => {
    expect(withStorage({ driveFolderPresets: [preset('a', '   '), preset('', 'Nameless id'), { name: 'No id' }] })
      .driveFolderPresets).toEqual([]);
  });

  it('collapses duplicates case-insensitively - one folder is one destination', () => {
    expect(withStorage({ driveFolderPresets: [preset('a', 'Interviews'), preset('b', 'interviews')] })
      .driveFolderPresets).toEqual([{ id: 'a', name: 'Interviews' }]);
  });

  it('caps the name length and the number of destinations', () => {
    const long = 'x'.repeat(MAX_DRIVE_FOLDER_NAME_LENGTH + 40);
    expect(withStorage({ driveFolderPresets: [preset('a', long)] })
      .driveFolderPresets[0].name).toHaveLength(MAX_DRIVE_FOLDER_NAME_LENGTH);

    const many = Array.from({ length: MAX_DRIVE_FOLDER_PRESETS + 5 }, (_, i) => preset(`id${i}`, `Folder ${i}`));
    expect(withStorage({ driveFolderPresets: many }).driveFolderPresets)
      .toHaveLength(MAX_DRIVE_FOLDER_PRESETS);
  });

  it('ignores junk rather than failing the whole settings load', () => {
    expect(withStorage({ driveFolderPresets: 'nope' }).driveFolderPresets).toEqual([]);
    expect(withStorage({ driveFolderPresets: [null, 7, 'x', preset('a', 'Work')] }).driveFolderPresets)
      .toEqual([{ id: 'a', name: 'Work' }]);
  });

  it('does not share preset objects between clones', () => {
    const settings = normalizeExtensionSettings({ storage: { driveFolderPresets: [preset('a', 'Work')] } });
    const clone = normalizeExtensionSettings(settings);
    clone.storage.driveFolderPresets[0].name = 'Mutated';
    expect(settings.storage.driveFolderPresets[0].name).toBe('Work');
  });
});
