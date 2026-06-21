import { applyRunConfigToForm, buildRunConfigFromForm } from '../popupRunConfig';
import type { PopupElements } from '../popupView';

function makeContentTypeGroup(): HTMLElement {
  const group = document.createElement('div');
  group.innerHTML = `
    <label><input type="radio" name="tab-content-type" value="screen" checked /></label>
    <label><input type="radio" name="tab-content-type" value="video" /></label>
  `;
  return group;
}

function makeElements(group: HTMLElement | null): PopupElements {
  const storageModeSelect = document.createElement('select');
  storageModeSelect.innerHTML = '<option value="local"></option><option value="drive"></option>';
  const micModeSelect = document.createElement('select');
  micModeSelect.innerHTML =
    '<option value="off"></option><option value="mixed"></option><option value="separate"></option>';
  const recordSelfVideoCheckbox = document.createElement('input');
  recordSelfVideoCheckbox.type = 'checkbox';

  return {
    storageModeSelect,
    micModeSelect,
    recordSelfVideoCheckbox,
    tabContentTypeGroup: group,
  } as unknown as PopupElements;
}

const radio = (group: HTMLElement, value: string) =>
  group.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;

describe('popupRunConfig — tab content type segmented control', () => {
  it('reads the selected segment into the run config', () => {
    const group = makeContentTypeGroup();
    const el = makeElements(group);

    expect(buildRunConfigFromForm(el).tabContentType).toBe('screen');

    radio(group, 'screen').checked = false;
    radio(group, 'video').checked = true;
    expect(buildRunConfigFromForm(el).tabContentType).toBe('video');
  });

  it('pre-selects the segment from a run config', () => {
    const group = makeContentTypeGroup();
    const el = makeElements(group);

    applyRunConfigToForm(el, {
      storageMode: 'local',
      micMode: 'off',
      recordSelfVideo: false,
      tabContentType: 'video',
    });

    expect(radio(group, 'video').checked).toBe(true);
  });

  it('falls back to the default content type when the group is absent', () => {
    const el = makeElements(null);
    expect(buildRunConfigFromForm(el).tabContentType).toBe('screen');
  });
});
