import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { getGlobalNessyDir, resolvePath } from './paths.js';

describe('channels/base paths – getGlobalNessyDir', () => {
  const originalEnv = process.env['NESSY_HOME'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['NESSY_HOME'] = originalEnv;
    } else {
      delete process.env['NESSY_HOME'];
    }
  });

  it('defaults to ~/.nessy when NESSY_HOME is not set', () => {
    delete process.env['NESSY_HOME'];
    expect(getGlobalNessyDir()).toBe(path.join(os.homedir(), '.nessy'));
  });

  it('uses NESSY_HOME when set to absolute path', () => {
    const configDir = path.resolve('/tmp/custom-nessy');
    process.env['NESSY_HOME'] = configDir;
    expect(getGlobalNessyDir()).toBe(configDir);
  });

  it('resolves relative NESSY_HOME against process.cwd', () => {
    process.env['NESSY_HOME'] = 'relative/config';
    expect(getGlobalNessyDir()).toBe(path.resolve('relative/config'));
  });

  it('expands tilde (~/x) in NESSY_HOME', () => {
    process.env['NESSY_HOME'] = '~/custom-nessy';
    expect(getGlobalNessyDir()).toBe(path.join(os.homedir(), 'custom-nessy'));
  });

  it('expands Windows-style tilde (~\\x) in NESSY_HOME', () => {
    process.env['NESSY_HOME'] = '~\\custom-nessy';
    expect(getGlobalNessyDir()).toBe(path.join(os.homedir(), 'custom-nessy'));
  });

  it('treats bare tilde (~) as home directory', () => {
    process.env['NESSY_HOME'] = '~';
    expect(getGlobalNessyDir()).toBe(os.homedir());
  });
});

describe('channels/base paths – resolvePath', () => {
  it('returns absolute paths unchanged', () => {
    const abs = path.resolve('/tmp/x');
    expect(resolvePath(abs)).toBe(abs);
  });

  it('expands bare tilde (~) to home directory', () => {
    expect(resolvePath('~')).toBe(os.homedir());
  });

  it('expands POSIX-style tilde (~/x)', () => {
    expect(resolvePath('~/xomo')).toBe(path.join(os.homedir(), 'xomo'));
  });

  it('expands Windows-style tilde (~\\x)', () => {
    expect(resolvePath('~\\xomo')).toBe(path.join(os.homedir(), 'xomo'));
  });

  it('resolves relative paths against process.cwd', () => {
    expect(resolvePath('relative/dir')).toBe(path.resolve('relative/dir'));
  });
});
