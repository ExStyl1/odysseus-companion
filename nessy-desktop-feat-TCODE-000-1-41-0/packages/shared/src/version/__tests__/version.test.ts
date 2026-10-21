import { describe, expect, it } from 'bun:test';
import rootPkg from '../../../../../package.json';
import electronPkg from '../../../../../apps/electron/package.json';
import { APP_VERSION, getAppVersion } from '../index.ts';

describe('app version', () => {
  it('uses the repository app version instead of the shared package version', () => {
    expect(APP_VERSION).toBe(rootPkg.version);
    expect(getAppVersion()).toBe(rootPkg.version);
  });

  it('keeps the Electron package version aligned with the repository version', () => {
    expect(electronPkg.version).toBe(rootPkg.version);
  });
});
