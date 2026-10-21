/**
 * Review fix (2026-08-13) to T1 ("sandbox.enabled kill switch") — the provider
 * bridge `registerManagedSandboxEnabledProvider` / `resolveManagedSandboxEnabledFloor`
 * in `storage.ts`, mirroring `registerManagedRetentionDaysProvider` /
 * `readManagedRetentionDays` exactly.
 *
 * Contours (b) (`getMacosSeatbeltBashSandboxEnabled`, covered end-to-end with
 * a real config dir in `storage-sandbox-master-switch.test.ts`) and (e)
 * (`CodexAgent.sandboxGloballyEnabled`, pinned by source-shape in
 * `../../agent/__tests__/codex-sandbox-globally-enabled.test.ts`) both
 * delegate to this one pair of functions, so their shared contract is proven
 * once, here, at the cheapest level: no subprocess needed (neither function
 * touches CONFIG_DIR), no CodexAgent instantiation needed.
 *
 * In-process (unlike the subprocess-per-test convention in
 * `storage-sandbox-master-switch.test.ts`): `managedSandboxEnabledProvider` is
 * a plain module-scope variable with no env/CONFIG_DIR dependency, so the
 * `NESSY_CONFIG_DIR` module-scope trap (AGENTS.md) does not apply here — but
 * the variable IS a process-wide singleton, so every test resets it via
 * `afterEach`, the same discipline
 * `storage-runtime-delivered-policy.test.ts` uses for the retention provider
 * this one mirrors.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { registerManagedSandboxEnabledProvider, resolveManagedSandboxEnabledFloor } from '../storage.ts';
import { resolveSandboxEnabled } from '../sandbox-settings.ts';

afterEach(() => {
  registerManagedSandboxEnabledProvider(undefined);
});

describe('resolveManagedSandboxEnabledFloor — the storage.ts provider bridge', () => {
  it('is undefined when nothing is registered', () => {
    expect(resolveManagedSandboxEnabledFloor()).toBeUndefined();
  });

  it('wraps a registered value as a floor object ready for resolveSandboxEnabled', () => {
    registerManagedSandboxEnabledProvider(() => true);
    expect(resolveManagedSandboxEnabledFloor()).toEqual({ enabled: true });
    registerManagedSandboxEnabledProvider(() => false);
    expect(resolveManagedSandboxEnabledFloor()).toEqual({ enabled: false });
  });

  it('is undefined when the registered provider itself returns undefined', () => {
    registerManagedSandboxEnabledProvider(() => undefined);
    expect(resolveManagedSandboxEnabledFloor()).toBeUndefined();
  });

  it('tolerates a throwing provider — no managed floor, not a thrown error', () => {
    registerManagedSandboxEnabledProvider(() => { throw new Error('policy file unreadable'); });
    expect(resolveManagedSandboxEnabledFloor()).toBeUndefined();
  });

  it('re-registering with undefined restores "no managed floor"', () => {
    registerManagedSandboxEnabledProvider(() => true);
    expect(resolveManagedSandboxEnabledFloor()).toEqual({ enabled: true });
    registerManagedSandboxEnabledProvider(undefined);
    expect(resolveManagedSandboxEnabledFloor()).toBeUndefined();
  });
});

/**
 * The exact expression both `getMacosSeatbeltBashSandboxEnabled` (contour b)
 * and `CodexAgent.sandboxGloballyEnabled` (contour e) now use:
 * `resolveSandboxEnabled([...], resolveManagedSandboxEnabledFloor())`.
 */
describe('resolveSandboxEnabled(userLayers, resolveManagedSandboxEnabledFloor()) — contour (b)/(e)\'s shared expression', () => {
  it('a managed floor enabled:true forces the result ON even when the user layer says false', () => {
    registerManagedSandboxEnabledProvider(() => true);
    expect(resolveSandboxEnabled([{ enabled: false }], resolveManagedSandboxEnabledFloor())).toBe(true);
  });

  it('a managed floor enabled:false forces the result OFF even when the user layer says true', () => {
    registerManagedSandboxEnabledProvider(() => false);
    expect(resolveSandboxEnabled([{ enabled: true }], resolveManagedSandboxEnabledFloor())).toBe(false);
  });

  it('with no provider registered, the user layer alone decides — today\'s behavior, unchanged', () => {
    expect(resolveSandboxEnabled([{ enabled: true }], resolveManagedSandboxEnabledFloor())).toBe(true);
    expect(resolveSandboxEnabled([{ enabled: false }], resolveManagedSandboxEnabledFloor())).toBe(false);
  });
});
