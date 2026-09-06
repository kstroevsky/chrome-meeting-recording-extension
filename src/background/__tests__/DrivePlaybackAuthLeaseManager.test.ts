/** ADR-0006 §16-17: the narrowest rule that works, and the token never leaves. */
import { DrivePlaybackAuthLeaseManager, driveMediaUrl } from '../DrivePlaybackAuthLeaseManager';
import * as dnr from '../../platform/chrome/declarativeNetRequest';

jest.mock('../../platform/chrome/declarativeNetRequest');

const getSessionRules = dnr.getSessionRules as jest.MockedFunction<typeof dnr.getSessionRules>;
const updateSessionRules = dnr.updateSessionRules as jest.MockedFunction<typeof dnr.updateSessionRules>;

const TOKEN = 'ya29.secret-token';
const FILE = 'drive-file-1';
const URL_ = driveMediaUrl(FILE);

function make(rules: unknown[] = []) {
  getSessionRules.mockResolvedValue(rules as never);
  updateSessionRules.mockResolvedValue(undefined);
  const getToken = jest.fn(async () => TOKEN);
  return { manager: new DrivePlaybackAuthLeaseManager({ getToken }), getToken };
}

const lastAdd = () => {
  const calls = updateSessionRules.mock.calls;
  return (calls[calls.length - 1][0].addRules ?? [])[0];
};

beforeEach(() => jest.clearAllMocks());

describe('authorize', () => {
  it('returns the media URL and installs a rule for exactly that file and tab', async () => {
    const { manager } = make();

    await expect(manager.authorize(42, FILE)).resolves.toBe(URL_);

    const rule = lastAdd()!;
    expect(rule.condition).toMatchObject({
      requestMethods: ['get'],
      resourceTypes: ['media'],
      tabIds: [42],
    });
    // Anchored to the exact URL: another Drive file in the same tab gets nothing.
    expect(rule.condition.regexFilter).toBe(`^${URL_.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  });

  it('never widens beyond the one googleapis host the spike measured', async () => {
    const { manager } = make();
    await manager.authorize(42, FILE);
    const filter = lastAdd()!.condition.regexFilter!;
    expect(filter).toContain('www\\.googleapis\\.com');
    expect(filter).not.toContain('.*');
  });

  it('sets the bearer header and returns no token to the caller', async () => {
    const { manager } = make();
    const returned = await manager.authorize(42, FILE);

    expect(lastAdd()!.action.requestHeaders).toEqual([
      { header: 'Authorization', operation: 'set', value: `Bearer ${TOKEN}` },
    ]);
    expect(returned).not.toContain(TOKEN);
  });

  it('replaces its own rule on re-authorization rather than stacking', async () => {
    const existing = {
      id: 9000,
      condition: { tabIds: [42], regexFilter: `^${URL_.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
    };
    const { manager, getToken } = make([existing]);

    await manager.authorize(42, FILE, { refresh: true });

    expect(getToken).toHaveBeenCalledWith({ refresh: true });
    expect(updateSessionRules).toHaveBeenCalledWith(expect.objectContaining({ removeRuleIds: [9000] }));
    expect(lastAdd()!.id).toBe(9000);
  });

  it('allocates around rules already installed for other tabs', async () => {
    const { manager } = make([{ id: 9000, condition: { tabIds: [7], regexFilter: '^other' } }]);
    await manager.authorize(42, FILE);
    expect(lastAdd()!.id).toBe(9001);
  });

  it('leaves rules outside its own id range alone', async () => {
    const foreign = { id: 12, condition: { tabIds: [42], regexFilter: '^whatever' } };
    const { manager } = make([foreign]);
    await manager.authorize(42, FILE);
    expect(updateSessionRules).toHaveBeenCalledWith(expect.objectContaining({ removeRuleIds: [] }));
  });
});

describe('release and reconcile', () => {
  it('drops every rule held for a closing tab', async () => {
    const { manager } = make([
      { id: 9000, condition: { tabIds: [42], regexFilter: '^a' } },
      { id: 9001, condition: { tabIds: [42], regexFilter: '^b' } },
      { id: 9002, condition: { tabIds: [7], regexFilter: '^c' } },
    ]);

    await manager.releaseTab(42);
    expect(updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [9000, 9001] });
  });

  it('does nothing when a tab holds no authorization', async () => {
    const { manager } = make([{ id: 9000, condition: { tabIds: [7], regexFilter: '^a' } }]);
    await manager.releaseTab(42);
    expect(updateSessionRules).not.toHaveBeenCalled();
  });

  /**
   * Session rules outlive the worker but tabs do not: without this a closed
   * player could leave a live credential attached to a recycled tab id.
   */
  it('drops authorizations whose tab is gone after a restart', async () => {
    const { manager } = make([
      { id: 9000, condition: { tabIds: [42], regexFilter: '^a' } },
      { id: 9001, condition: { tabIds: [99], regexFilter: '^b' } },
    ]);

    await expect(manager.reconcile([42])).resolves.toBe(1);
    expect(updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [9001] });
  });

  it('keeps every rule when all tabs are still open', async () => {
    const { manager } = make([{ id: 9000, condition: { tabIds: [42], regexFilter: '^a' } }]);
    await expect(manager.reconcile([42, 7])).resolves.toBe(0);
    expect(updateSessionRules).not.toHaveBeenCalled();
  });

  it('survives a browser that cannot read session rules', async () => {
    getSessionRules.mockRejectedValue(new Error('unavailable'));
    const warn = jest.fn();
    const manager = new DrivePlaybackAuthLeaseManager({ getToken: async () => TOKEN, warn });

    await expect(manager.reconcile([1])).resolves.toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});
