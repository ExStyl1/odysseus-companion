import { describe, expect, it } from 'bun:test';
import {
  createBypassGateArbiter,
  needsBypassPermissionsAcknowledgment,
  recordBypassPermissionsAcknowledgment,
  type BypassAckConfigApi,
} from '../bypass-permissions-gate.ts';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
  };
}

/** Fake of the two config IPC methods, with a call log for assertions. */
function fakeConfigApi(initialAcknowledged = false): BypassAckConfigApi & {
  acknowledged: boolean;
  setCalls: boolean[];
} {
  return {
    acknowledged: initialAcknowledged,
    setCalls: [],
    async getBypassPermissionsAcknowledged() {
      return this.acknowledged;
    },
    async setBypassPermissionsAcknowledged(value: boolean) {
      this.acknowledged = value;
      this.setCalls.push(value);
    },
  };
}

function brokenConfigApi(): BypassAckConfigApi {
  return {
    getBypassPermissionsAcknowledged: () => Promise.reject(new Error('no IPC')),
    setBypassPermissionsAcknowledged: () => Promise.reject(new Error('no IPC')),
  };
}

describe('bypassPermissions responsibility gate', () => {
  it('asks on first activation, then never again once acknowledged (config-backed)', async () => {
    const storage = memoryStorage();
    const configApi = fakeConfigApi(false);
    expect(await needsBypassPermissionsAcknowledgment(storage, configApi)).toBe(true);
    await recordBypassPermissionsAcknowledgment(configApi);
    expect(await needsBypassPermissionsAcknowledgment(storage, configApi)).toBe(false);
  });

  it('keeps asking when config AND storage are both unavailable, never silently skips', async () => {
    const broken = {
      getItem: () => { throw new Error('no storage'); },
      setItem: () => { throw new Error('no storage'); },
    };
    expect(await needsBypassPermissionsAcknowledgment(broken, brokenConfigApi())).toBe(true);
    await expect(recordBypassPermissionsAcknowledgment(brokenConfigApi())).resolves.toBeUndefined();
  });

  it('migrates a legacy localStorage "1" into config on first read, without deleting it', async () => {
    const storage = memoryStorage();
    storage.setItem('nessy:bypass-permissions-acknowledged', '1');
    const configApi = fakeConfigApi(false);

    expect(await needsBypassPermissionsAcknowledgment(storage, configApi)).toBe(false);
    // One-way migration: the config key now durably holds the acceptance.
    expect(configApi.acknowledged).toBe(true);
    expect(configApi.setCalls).toEqual([true]);
    // The legacy entry is a dead key, never deleted (a downgrade must not
    // re-prompt endlessly).
    expect(storage.data.get('nessy:bypass-permissions-acknowledged')).toBe('1');
  });

  it('config already true takes priority — no redundant migration write', async () => {
    const storage = memoryStorage();
    storage.setItem('nessy:bypass-permissions-acknowledged', '1');
    const configApi = fakeConfigApi(true);

    expect(await needsBypassPermissionsAcknowledgment(storage, configApi)).toBe(false);
    // Config already said yes — the legacy flag is never even consulted, so
    // no redundant write happens.
    expect(configApi.setCalls).toEqual([]);
  });

  it('no legacy flag and config false: needs acknowledgment, no config write happens', async () => {
    const storage = memoryStorage();
    const configApi = fakeConfigApi(false);

    expect(await needsBypassPermissionsAcknowledgment(storage, configApi)).toBe(true);
    expect(configApi.setCalls).toEqual([]);
  });

  it('recordBypassPermissionsAcknowledgment writes true to config (single durable source — no storage param exists to touch)', async () => {
    const configApi = fakeConfigApi(false);
    await recordBypassPermissionsAcknowledgment(configApi);
    expect(configApi.acknowledged).toBe(true);
    expect(configApi.setCalls).toEqual([true]);
  });
});

/**
 * The interleaving rule the async gate needs and the synchronous one got free.
 *
 * Found by review, not by failure: making the check an IPC round trip removed
 * the implicit mutual exclusion of a single-tick "check then act", so a stale
 * check could raise the responsibility dialog for an action the user had moved
 * past — and confirming it would switch a session into bypassPermissions nobody
 * asked for.
 */
describe('createBypassGateArbiter', () => {
  it('the only ticket outstanding is current', () => {
    const arbiter = createBypassGateArbiter();
    const ticket = arbiter.begin();
    expect(arbiter.isCurrent(ticket)).toBe(true);
  });

  it('a later check supersedes an in-flight one: the earlier ticket goes stale', () => {
    const arbiter = createBypassGateArbiter();
    const first = arbiter.begin();
    const second = arbiter.begin();

    // This is the whole point: `first` resolving after `second` began must not act.
    expect(arbiter.isCurrent(first)).toBe(false);
    expect(arbiter.isCurrent(second)).toBe(true);
  });

  it('staleness is permanent — a superseded ticket never becomes current again', () => {
    const arbiter = createBypassGateArbiter();
    const first = arbiter.begin();
    arbiter.begin();
    arbiter.begin();
    expect(arbiter.isCurrent(first)).toBe(false);
  });

  it('two arbiters are independent, so one component cannot invalidate another', () => {
    const a = createBypassGateArbiter();
    const b = createBypassGateArbiter();
    const ticketA = a.begin();
    b.begin();
    expect(a.isCurrent(ticketA)).toBe(true);
  });

  it('drives the real await ordering: the slow first check does not act, the fast second does', async () => {
    const arbiter = createBypassGateArbiter();
    const acted: string[] = [];

    const check = async (label: string, delayMs: number) => {
      const ticket = arbiter.begin();
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (!arbiter.isCurrent(ticket)) return;
      acted.push(label);
    };

    // `slow` begins first and resolves last — exactly the shape that used to
    // resurrect an abandoned request.
    await Promise.all([check('slow', 20), check('fast', 1)]);

    expect(acted).toEqual(['fast']);
  });
});
