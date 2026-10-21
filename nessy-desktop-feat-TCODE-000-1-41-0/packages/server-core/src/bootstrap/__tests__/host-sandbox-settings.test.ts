import { describe, expect, test } from 'bun:test';
import { withDpStateRootWriteGrant } from '../host-sandbox-settings.ts';

// `as never` is cast at each call site below rather than on this const: typing
// the literal itself `never` makes `{ ...base, ... }` a TS2698 error (spread
// requires an object type), which the last test needs.
const base = Object.freeze({
  excludedCommands: Object.freeze([]),
  deniedReadRoots: Object.freeze(['/home/u/.nessy', '/home/u/.ssh']),
  deniedWriteRoots: Object.freeze([]),
  additionalWritableRoots: Object.freeze([]),
  allowUnsandboxedCommands: false,
  network: Object.freeze({}),
  filesystem: Object.freeze({ disabled: false }),
});

describe('withDpStateRootWriteGrant', () => {
  test('appends the resolved dp state root as a writable root', () => {
    const out = withDpStateRootWriteGrant(base as never, undefined, () => '/home/u/.dp');
    expect(out.additionalWritableRoots).toEqual(['/home/u/.dp']);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.additionalWritableRoots)).toBe(true);
  });

  test('no dp root -> settings returned unchanged (same reference)', () => {
    expect(withDpStateRootWriteGrant(base as never, undefined, () => undefined)).toBe(base as never);
  });

  test('a dp root inside a denied root is refused with one diagnostic', () => {
    const diags: string[] = [];
    const out = withDpStateRootWriteGrant(base as never, m => diags.push(m), () => '/home/u/.nessy/dp');
    expect(out).toBe(base as never);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toContain('/home/u/.nessy');
  });

  test('an already-granted root is not duplicated', () => {
    const granted = Object.freeze({ ...base, additionalWritableRoots: Object.freeze(['/home/u/.dp']) });
    expect(withDpStateRootWriteGrant(granted as never, undefined, () => '/home/u/.dp')).toBe(granted as never);
  });
});
