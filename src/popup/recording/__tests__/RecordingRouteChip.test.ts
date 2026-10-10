import { findRecordingRouteChip, RecordingRouteChip } from '../RecordingRouteChip';
import type { RecordingStatusView } from '../../../shared/recording';
import type { RecordingRouteView } from '../../../integrations/RecordingRoutingService';

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const CRM: RecordingRouteView = { destinationId: 'destination_crm', destinationName: 'CheekyCheeseIT CRM', state: 'held' };

function mount() {
  document.body.innerHTML = `
    <div id="rec-route" hidden>
      <span id="rec-route-label"></span>
      <button id="rec-route-retry" type="button" hidden>Retry automation</button>
    </div>`;
  return findRecordingRouteChip(document)!;
}

const session = (destinationProfileId?: string, runningSince = 1) => ({
  phase: 'recording',
  runningSince,
  runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false, ...(destinationProfileId ? { destinationProfileId } : {}) },
  updatedAt: 1,
} as RecordingStatusView);

describe('RecordingRouteChip', () => {
  it('names the integration under the timer while recording', async () => {
    const el = mount();
    const routes = jest.fn(async () => [CRM]);
    new RecordingRouteChip(el, routes).sync('recording', session('profile-crm'));
    await flush();

    expect(el.root.hidden).toBe(false);
    expect(el.label.textContent).toBe('→ CheekyCheeseIT CRM');
    expect(el.retry.hidden).toBe(true);
  });

  it('stays hidden for a built-in destination and asks nothing', async () => {
    const el = mount();
    const routes = jest.fn(async () => [CRM]);
    new RecordingRouteChip(el, routes).sync('recording', session('builtin:local'));
    await flush();
    expect(el.root.hidden).toBe(true);
    expect(routes).not.toHaveBeenCalled();
  });

  it('asks once per run, not on every status tick', async () => {
    const el = mount();
    const routes = jest.fn(async () => [CRM]);
    const chip = new RecordingRouteChip(el, routes);
    chip.sync('recording', session('profile-crm'));
    chip.sync('recording', session('profile-crm'));
    await flush();
    expect(routes).toHaveBeenCalledTimes(1);

    chip.sync('idle', session('profile-crm'));
    expect(el.root.hidden).toBe(true);
    chip.sync('recording', session('profile-crm', 2));
    await flush();
    expect(routes).toHaveBeenCalledTimes(2);
  });

  it('says when automation could not be scheduled, and retries it', async () => {
    const el = mount();
    const routes = jest.fn(async (retry: boolean) => (retry ? [CRM] : [{ ...CRM, state: 'not-scheduled' as const }]));
    new RecordingRouteChip(el, routes).sync('recording', session('profile-crm'));
    await flush();
    expect(el.label.textContent).toBe('Recording for CheekyCheeseIT CRM, but automation could not be scheduled');
    expect(el.retry.hidden).toBe(false);
    expect(el.root.classList.contains('rec-route--warn')).toBe(true);

    el.retry.click();
    await flush();
    expect(routes).toHaveBeenLastCalledWith(true);
    expect(el.label.textContent).toBe('→ CheekyCheeseIT CRM');
    expect(el.retry.hidden).toBe(true);
  });

  it('says nothing, rather than raising an alarm, when the routes cannot be read', async () => {
    const el = mount();
    new RecordingRouteChip(el, async () => { throw new Error('offline'); }).sync('recording', session('profile-crm'));
    await flush();
    expect(el.root.hidden).toBe(true);
  });

  it('ignores an answer for a run that has already ended', async () => {
    const el = mount();
    let answer!: (routes: RecordingRouteView[]) => void;
    const chip = new RecordingRouteChip(el, () => new Promise((resolve) => { answer = resolve; }));
    chip.sync('recording', session('profile-crm'));
    chip.sync('idle', session('profile-crm'));
    answer([CRM]);
    await flush();
    expect(el.root.hidden).toBe(true);
  });

  it('is inert without its markup', () => {
    document.body.innerHTML = '';
    expect(() => new RecordingRouteChip(findRecordingRouteChip(document)).sync('recording', session('profile-crm'))).not.toThrow();
  });
});
