/**
 * @file popup/recording/DevicePickerView.ts
 *
 * The bottom sheet that switches the live microphone or camera track mid-run.
 *
 * It owns the sheet's DOM, the enumeration it lists, and the request fencing
 * that keeps a slow `enumerateDevices` from painting over a picker the user has
 * since closed or reopened for the other device. It knows nothing about the
 * protocol: switching a track is an action the caller supplies, so the same
 * view drives the live popup and the deterministic gallery preview.
 */

import type { PopupElements } from '../popupView';
import type { PopupPreviewDeviceOption } from '../popupPreviewState';
import type { RecordingInputDevice, RecordingStatusView } from '../../shared/recording';

export type DevicePickerElements = Pick<
  PopupElements,
  | 'micDeviceTrigger'
  | 'cameraDeviceTrigger'
  | 'devicePicker'
  | 'devicePickerTitle'
  | 'devicePickerList'
  | 'devicePickerError'
  | 'devicePickerTrack'
  | 'devicePickerMode'
  | 'devicePickerClose'
>;

export type DevicePickerActions = {
  /**
   * Switches the live track. Resolves with the label now being captured, or
   * throws with a message the sheet shows in place.
   */
  select: (device: RecordingInputDevice, deviceId: string) => Promise<string | undefined>;
  notify: (message: string) => void;
};

/** Chrome exposes `default` as a virtual alias alongside the same physical input. */
export function normalizedInputLabel(label: string): string {
  return label.trim().replace(/^default\s*[-:]\s*/i, '').replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** Keeps a system-default alias only when it is not also represented by a physical device. */
export function uniqueInputDevices(devices: MediaDeviceInfo[], kind: MediaDeviceKind): MediaDeviceInfo[] {
  const physicalLabels = new Set(
    devices
      .filter((item) => item.kind === kind && item.deviceId && item.deviceId !== 'default')
      .map((item) => normalizedInputLabel(item.label))
      .filter(Boolean)
  );
  return devices.filter((item) => {
    if (item.kind !== kind || !item.deviceId) return false;
    return item.deviceId !== 'default' || !physicalLabels.has(normalizedInputLabel(item.label));
  });
}

/** Makes a retained browser alias clear without presenting it as duplicate hardware. */
export function inputDeviceLabel(item: MediaDeviceInfo, fallback: string): string {
  const label = item.label.trim();
  if (item.deviceId !== 'default') return label || fallback;
  const target = normalizedInputLabel(label);
  return target ? `System default — ${label.replace(/^default\s*[-:]\s*/i, '').trim()}` : 'System default';
}

const DEVICE_NOUN: Record<RecordingInputDevice, string> = { microphone: 'Microphone', camera: 'Camera' };

export class DevicePickerView {
  private readonly el: Partial<DevicePickerElements>;
  private session?: RecordingStatusView;
  private active: RecordingInputDevice | null = null;
  /** Fences a slow enumeration against a picker that has since moved on. */
  private requestId = 0;

  constructor(
    el: Partial<DevicePickerElements> | null | undefined,
    private readonly actions: DevicePickerActions,
  ) {
    this.el = el ?? {};
  }

  /** Wires opening, closing and Escape. The preview wires only {@link wireDismissal}. */
  wire(): void {
    this.el.micDeviceTrigger?.addEventListener('click', () => void this.open('microphone'));
    this.el.cameraDeviceTrigger?.addEventListener('click', () => void this.open('camera'));
    this.wireDismissal();
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.active) this.close();
    });
  }

  /** The close interactions a static preview can safely run. */
  wireDismissal(): void {
    this.el.devicePickerClose?.addEventListener('click', () => this.close());
    this.el.devicePicker?.querySelector<HTMLElement>('[data-device-picker-dismiss]')
      ?.addEventListener('click', () => this.close());
  }

  /** The session the sheet reads its mode and currently-captured device from. */
  sync(session?: RecordingStatusView): void {
    this.session = session;
  }

  /** Opens with fixed options and no enumeration — the gallery's path. */
  showPreview(device: RecordingInputDevice, options: PopupPreviewDeviceOption[]): void {
    if (!this.el.devicePicker || !this.el.devicePickerList) return;
    this.paintFrame(device);
    this.renderOptions(options);
  }

  close(restoreFocus = true): void {
    const device = this.active;
    // Bumped on close so an enumeration still in flight cannot paint into the
    // sheet the user has just dismissed.
    this.requestId += 1;
    this.active = null;
    if (this.el.devicePicker) this.el.devicePicker.hidden = true;
    if (!restoreFocus || !device) return;
    (device === 'microphone' ? this.el.micDeviceTrigger : this.el.cameraDeviceTrigger)?.focus();
  }

  private async open(device: RecordingInputDevice): Promise<void> {
    if (this.session?.phase !== 'recording' || !this.el.devicePicker || !this.el.devicePickerList) return;

    const requestId = ++this.requestId;
    this.paintFrame(device);
    this.el.devicePickerList.replaceChildren(message('Loading devices…'));

    try {
      const devices = await navigator.mediaDevices?.enumerateDevices?.();
      if (!this.isCurrent(device, requestId)) return;
      const kind: MediaDeviceKind = device === 'microphone' ? 'audioinput' : 'videoinput';
      const available = uniqueInputDevices(devices ?? [], kind);
      if (available.length === 0) {
        this.el.devicePickerList.replaceChildren(
          message(`No ${device === 'microphone' ? 'microphones' : 'cameras'} found`),
        );
        return;
      }

      const currentLabel = this.session?.capturedDevices?.[device];
      this.renderOptions(available.map((item, index) => ({
        id: item.deviceId,
        label: inputDeviceLabel(item, `${DEVICE_NOUN[device]} ${index + 1}`),
        selected: Boolean(currentLabel && normalizedInputLabel(item.label) === normalizedInputLabel(currentLabel)),
      })), true);
    } catch (error: unknown) {
      console.error('[popup] enumerateDevices error', error);
      if (this.isCurrent(device, requestId)) {
        this.el.devicePickerList.replaceChildren(message('Unable to list devices'));
      }
    }
  }

  private isCurrent(device: RecordingInputDevice, requestId: number): boolean {
    return this.active === device && this.requestId === requestId;
  }

  /** The sheet's chrome — identical for the live picker and the preview. */
  private paintFrame(device: RecordingInputDevice): void {
    this.active = device;
    if (this.el.devicePicker) this.el.devicePicker.hidden = false;
    if (this.el.devicePickerTitle) this.el.devicePickerTitle.textContent = device.toUpperCase();
    if (this.el.devicePickerTrack) {
      this.el.devicePickerTrack.textContent = device === 'microphone' ? 'Audio track' : 'Video track';
    }
    if (this.el.devicePickerMode) {
      this.el.devicePickerMode.textContent = device === 'microphone'
        ? (this.session?.runConfig?.micMode ?? 'separate').toUpperCase()
        : '720P';
    }
    if (this.el.devicePickerError) {
      this.el.devicePickerError.hidden = true;
      this.el.devicePickerError.textContent = '';
    }
  }

  private renderOptions(options: PopupPreviewDeviceOption[], focusSelected = false): void {
    if (!this.el.devicePickerList) return;
    const rendered = options.map((item) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'device-picker-option';
      option.dataset.deviceId = item.id;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(item.selected === true));

      const copy = document.createElement('span');
      copy.className = 'device-picker-option-label';
      copy.textContent = item.label;
      option.append(copy);
      if (item.selected) option.append(check());
      option.addEventListener('click', () => void this.selectDevice(item.id));
      return option;
    });
    this.el.devicePickerList.replaceChildren(...rendered);
    if (focusSelected) rendered.find((option) => option.getAttribute('aria-selected') === 'true')?.focus();
  }

  private async selectDevice(deviceId: string): Promise<void> {
    const device = this.active;
    if (!device || !deviceId || !this.el.devicePickerList) return;
    const options = Array.from(this.el.devicePickerList.querySelectorAll<HTMLButtonElement>('.device-picker-option'));
    // Disabled together: a second click while the switch is in flight would race
    // two track changes against the same recorder.
    options.forEach((option) => { option.disabled = true; });
    if (this.el.devicePickerError) this.el.devicePickerError.hidden = true;

    try {
      const label = await this.actions.select(device, deviceId);
      this.actions.notify(`${DEVICE_NOUN[device]} changed${label ? ` to ${label}` : ''}`);
      this.close();
    } catch (error: unknown) {
      console.error('[popup] SET_INPUT_DEVICE error', error);
      options.forEach((option) => { option.disabled = false; });
      if (this.el.devicePickerError) {
        this.el.devicePickerError.hidden = false;
        this.el.devicePickerError.textContent =
          error instanceof Error ? error.message : `Failed to change ${device}`;
      }
    }
  }
}

function message(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'device-picker-empty';
  el.textContent = text;
  return el;
}

function check(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'device-picker-check');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M3 8.2l3.1 3.1L13 4.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
}
