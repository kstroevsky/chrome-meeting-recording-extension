import { normalizeExtensionSettings } from '../normalize';

const local = (presets: unknown) =>
  normalizeExtensionSettings({ storage: { localFolderPresets: presets } } as never).storage.localFolderPresets;

describe('local folder presets', () => {
  it('defaults to none, so everything lands in the download directory itself', () => {
    expect(normalizeExtensionSettings({}).storage.localFolderPresets).toEqual([]);
  });

  it('keeps well-formed folders in order', () => {
    expect(local([{ id: 'a', name: 'Therapy 2026' }, { id: 'b', name: 'Client work' }]))
      .toEqual([{ id: 'a', name: 'Therapy 2026' }, { id: 'b', name: 'Client work' }]);
  });

  it('strips the characters Windows cannot put in a directory name', () => {
    // Drive tolerates these; a real path segment does not.
    expect(local([{ id: 'a', name: 'Q1: notes <draft>' }])).toEqual([{ id: 'a', name: 'Q1 notes draft' }]);
    expect(local([{ id: 'b', name: 'why? "quoted" | piped*' }]))
      .toEqual([{ id: 'b', name: 'why quoted piped' }]);
  });

  it('strips path separators, so a name can never become a nested path', () => {
    expect(local([{ id: 'a', name: '../../etc' }])).toEqual([{ id: 'a', name: '.. .. etc' }]);
    expect(local([{ id: 'b', name: 'a/b\\c' }])).toEqual([{ id: 'b', name: 'a b c' }]);
  });

  it('drops a trailing dot, which is legal to type and invalid as a directory', () => {
    expect(local([{ id: 'a', name: 'Notes...' }])).toEqual([{ id: 'a', name: 'Notes' }]);
  });

  it('collapses names that would resolve to the same folder', () => {
    expect(local([{ id: 'a', name: 'Therapy' }, { id: 'b', name: 'therapy' }]))
      .toEqual([{ id: 'a', name: 'Therapy' }]);
  });

  it('discards entries with no usable name left, rather than keeping an empty folder', () => {
    expect(local([{ id: 'a', name: '///' }, { id: 'b', name: '   ' }, { id: 'c' }])).toEqual([]);
  });

  it('is independent of the Drive list', () => {
    const settings = normalizeExtensionSettings({
      storage: {
        driveFolderPresets: [{ id: 'd1', name: 'Psychotherapy' }],
        localFolderPresets: [{ id: 'l1', name: 'Therapy 2026' }],
      },
    } as never);
    expect(settings.storage.driveFolderPresets).toEqual([{ id: 'd1', name: 'Psychotherapy' }]);
    expect(settings.storage.localFolderPresets).toEqual([{ id: 'l1', name: 'Therapy 2026' }]);
  });
});
