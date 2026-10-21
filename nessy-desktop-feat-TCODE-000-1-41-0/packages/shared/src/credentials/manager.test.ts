import { describe, expect, test } from 'bun:test';
import type { CredentialBackend } from './backends/types.ts';
import { CredentialManager } from './manager.ts';

function backend(overrides: Partial<CredentialBackend>): CredentialBackend {
  return {
    name: 'test-backend',
    priority: 1,
    isAvailable: async () => true,
    get: async () => null,
    set: async () => {},
    delete: async () => false,
    deleteSync: () => false,
    list: async () => [],
    ...overrides,
  };
}

describe('CredentialManager delete failures', () => {
  test('propagates an asynchronous backend failure', async () => {
    const manager = new CredentialManager(backend({
      delete: async () => { throw new Error('backend-delete-failed'); },
    }));

    await expect(manager.delete({ type: 'anthropic_api_key' }))
      .rejects.toThrow('backend-delete-failed');
  });

  test('propagates a synchronous backend failure', () => {
    const manager = new CredentialManager(backend({
      deleteSync: () => { throw new Error('backend-delete-sync-failed'); },
    }));

    expect(() => manager.deleteSync({ type: 'anthropic_api_key' }))
      .toThrow('backend-delete-sync-failed');
  });

  test('fails closed when a backend cannot delete synchronously', () => {
    const noSync = backend({});
    delete noSync.deleteSync;
    const manager = new CredentialManager(noSync);

    expect(() => manager.deleteSync({ type: 'anthropic_api_key' }))
      .toThrow('does not support synchronous delete');
  });
});
