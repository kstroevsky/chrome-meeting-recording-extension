/** User-named Drive destinations: sanitised, because a name becomes a folder. */
import { normalizeExtensionSettings } from '../normalize';
import {
  DEFAULT_DRIVE_ROOT_FOLDER_NAME,
  LEGACY_DRIVE_ROOT_FOLDER_NAME,
  MAX_DRIVE_FOLDER_NAME_LENGTH,
  MAX_DRIVE_FOLDER_PRESETS,
} from '../defaults';
import { DEFAULT_EXTENSION_SETTINGS } from '../defaults';

const withStorage = (storage: unknown) => normalizeExtensionSettings({ storage }).storage;
const preset = (id: string, name: string) => ({ id, name });

describe('drive folder presets', () => {
  it('defaults to none, which is the pre-presets behaviour', () => {
    expect(normalizeExtensionSettings({}).storage)
      .toEqual({ driveRootFolderName: LEGACY_DRIVE_ROOT_FOLDER_NAME, driveFolderPresets: [], localFolderPresets: [] });
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

/**
 * The root folder is resolved by name, so the name a given installation ends up
 * with decides which folder its recordings are findable in.
 */
describe('the root folder everything lives in', () => {
  it('is the new name for an installation that has never stored settings', () => {
    expect(DEFAULT_EXTENSION_SETTINGS.storage.driveRootFolderName).toBe(DEFAULT_DRIVE_ROOT_FOLDER_NAME);
  });

  it('stays the old name for an installation that predates the setting', () => {
    // Its recordings are already in that folder; handing it the new default
    // would leave half a library somewhere nothing looks.
    expect(withStorage({ driveFolderPresets: [] }).driveRootFolderName).toBe(LEGACY_DRIVE_ROOT_FOLDER_NAME);
  });

  it('keeps a name the user chose', () => {
    expect(withStorage({ driveRootFolderName: 'Meetings' }).driveRootFolderName).toBe('Meetings');
  });

  it('falls back rather than leaving the recordings with no folder to live in', () => {
    expect(withStorage({ driveRootFolderName: '   ' }).driveRootFolderName).toBe(LEGACY_DRIVE_ROOT_FOLDER_NAME);
    expect(withStorage({ driveRootFolderName: '///' }).driveRootFolderName).toBe(LEGACY_DRIVE_ROOT_FOLDER_NAME);
    expect(withStorage({ driveRootFolderName: 42 }).driveRootFolderName).toBe(LEGACY_DRIVE_ROOT_FOLDER_NAME);
  });

  it('sanitises a name the way a destination name is sanitised', () => {
    expect(withStorage({ driveRootFolderName: '  My  Recordings/2026 ' }).driveRootFolderName).toBe('My Recordings 2026');
    expect(withStorage({ driveRootFolderName: 'x'.repeat(MAX_DRIVE_FOLDER_NAME_LENGTH + 10) }).driveRootFolderName)
      .toHaveLength(MAX_DRIVE_FOLDER_NAME_LENGTH);
  });
});
