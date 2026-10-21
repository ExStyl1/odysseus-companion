import { describe, expect, it } from 'bun:test';
import { buildElectronDevEnv } from './electron-dev-env.ts';

describe('buildElectronDevEnv', () => {
  it('keeps the default config root implicit when no override is configured', () => {
    expect(buildElectronDevEnv({ HOME: '/tmp/home' })).not.toHaveProperty('NESSY_CONFIG_DIR');
    expect(buildElectronDevEnv({ HOME: '/tmp/home', NESSY_CONFIG_DIR: '' })).not.toHaveProperty('NESSY_CONFIG_DIR');
  });

  it('preserves an explicit multi-instance or custom config root', () => {
    expect(buildElectronDevEnv({
      HOME: '/tmp/home',
      NESSY_CONFIG_DIR: '/tmp/home/.nessy-agent-2',
      NESSY_VITE_PORT: '2173',
    })).toMatchObject({
      NESSY_CONFIG_DIR: '/tmp/home/.nessy-agent-2',
      VITE_DEV_SERVER_URL: 'http://localhost:2173',
    });
  });
});
