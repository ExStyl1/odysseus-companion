import { afterEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REMOTE_BINDING_MUTATION_STEPS,
  RemoteWorkspaceLocalCommitError,
  createWorkspaceService,
  type RemoteWorkspaceGateway,
  type WorkspaceCredentialManager,
} from '../service.ts';

setDefaultTimeout(15_000);

class MemoryCredentials implements WorkspaceCredentialManager {
  readonly remoteTokens = new Map<string, string>();
  readonly otherCredentialWorkspaces = new Set<string>();

  async list(filter?: { workspaceId?: string }): Promise<unknown[]> {
    const workspaceId = filter?.workspaceId;
    if (!workspaceId) return [];
    return this.otherCredentialWorkspaces.has(workspaceId) ? [{}] : [];
  }

  async getRemoteServerToken(workspaceId: string): Promise<string | null> {
    return this.remoteTokens.get(workspaceId) ?? null;
  }

  async setRemoteServerToken(workspaceId: string, token: string): Promise<void> {
    this.remoteTokens.set(workspaceId, token);
  }

  async deleteRemoteServerToken(workspaceId: string): Promise<boolean> {
    return this.remoteTokens.delete(workspaceId);
  }

  async deleteWorkspaceCredentials(workspaceId: string): Promise<void> {
    this.remoteTokens.delete(workspaceId);
    this.otherCredentialWorkspaces.delete(workspaceId);
  }
}

function gateway(): RemoteWorkspaceGateway {
  return {
    verifyConnection: mock(async () => {}),
    createWorkspace: mock(async () => ({ remoteWorkspaceId: 'remote-created' })),
  };
}

const dirs: string[] = [];
function makeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-remote-binding-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('WorkspaceService remote binding', () => {
  it('normalizes the URL, persists no token, and reports only the exact remote credential', async () => {
    const configDir = makeConfigDir();
    const credentials = new MemoryCredentials();
    credentials.otherCredentialWorkspaces.add('unrelated');
    const remoteGateway = gateway();
    const service = createWorkspaceService({ configDir, credentialManager: credentials, remoteGateway });

    const local = await service.create({ name: 'Local only' });
    credentials.otherCredentialWorkspaces.add(local.id);
    expect((await service.list()).find(item => item.id === local.id)?.hasCredential).toBe(false);

    const connected = await service.connectRemoteWorkspace({
      name: 'Remote',
      url: ' WSS://REMOTE.EXAMPLE.TEST:443 ',
      token: 'distinctive-remote-secret',
      remoteWorkspaceId: 'remote-1',
    });

    expect(remoteGateway.verifyConnection).toHaveBeenCalledWith({
      url: 'wss://remote.example.test/',
      token: 'distinctive-remote-secret',
      remoteWorkspaceId: 'remote-1',
    });
    expect(connected.remoteServer).toEqual({
      url: 'wss://remote.example.test/',
      remoteWorkspaceId: 'remote-1',
    });
    expect(connected.hasCredential).toBe(true);
    expect(JSON.stringify(connected)).not.toContain('distinctive-remote-secret');

    const resolved = service.resolve(connected.id);
    expect(JSON.stringify(resolved.config)).not.toContain('distinctive-remote-secret');
    expect(readFileSync(join(resolved.workspaceRootPath, 'config.json'), 'utf8'))
      .not.toContain('distinctive-remote-secret');
    expect(await service.resolveRemoteWorkspaceConnection(connected.id)).toEqual({
      localWorkspaceId: connected.id,
      url: 'wss://remote.example.test/',
      remoteWorkspaceId: 'remote-1',
      token: 'distinctive-remote-secret',
    });
  });

  it('allows omitted update tokens only for an unchanged normalized endpoint and remote ID', async () => {
    const configDir = makeConfigDir();
    const credentials = new MemoryCredentials();
    const remoteGateway = gateway();
    const service = createWorkspaceService({ configDir, credentialManager: credentials, remoteGateway });
    const connected = await service.connectRemoteWorkspace({
      name: 'Remote', url: 'wss://remote.example.test', token: 'old-token', remoteWorkspaceId: 'remote-1',
    });

    await expect(service.updateRemoteWorkspace({
      workspaceId: connected.id,
      url: 'WSS://REMOTE.EXAMPLE.TEST:443/',
      remoteWorkspaceId: 'remote-1',
    })).resolves.toMatchObject({ id: connected.id, hasCredential: true });

    await expect(service.updateRemoteWorkspace({
      workspaceId: connected.id,
      url: 'wss://other.example.test',
      remoteWorkspaceId: 'remote-1',
    })).rejects.toThrow('A fresh remote token is required');
    expect(await service.resolveRemoteWorkspaceConnection(connected.id)).toMatchObject({
      url: 'wss://remote.example.test/', token: 'old-token', remoteWorkspaceId: 'remote-1',
    });
  });

  it('reconnects an already committed remote binding idempotently', async () => {
    const configDir = makeConfigDir();
    const credentials = new MemoryCredentials();
    const remoteGateway = gateway();
    const service = createWorkspaceService({ configDir, credentialManager: credentials, remoteGateway });
    const first = await service.connectRemoteWorkspace({
      name: 'Remote', url: 'wss://remote.example.test', token: 'old-token', remoteWorkspaceId: 'remote-1',
    });

    const retried = await service.connectRemoteWorkspace({
      name: ' Remote ', url: 'WSS://REMOTE.EXAMPLE.TEST:443', token: 'new-token', remoteWorkspaceId: 'remote-1',
    });

    expect(retried.id).toBe(first.id);
    expect(await service.resolveRemoteWorkspaceConnection(first.id)).toMatchObject({ token: 'new-token' });
    expect(await service.list()).toHaveLength(1);
  });

  it('leaves either the old or new complete binding at every update failpoint', async () => {
    for (const failAt of REMOTE_BINDING_MUTATION_STEPS) {
      const configDir = makeConfigDir();
      const credentials = new MemoryCredentials();
      const remoteGateway = gateway();
      const setup = createWorkspaceService({ configDir, credentialManager: credentials, remoteGateway });
      const connected = await setup.connectRemoteWorkspace({
        name: 'Remote', url: 'wss://old.example.test', token: 'old-token', remoteWorkspaceId: 'old-id',
      });
      let fired = false;
      const service = createWorkspaceService({
        configDir,
        credentialManager: credentials,
        remoteGateway,
        remoteBindingFailpoint(step) {
          if (!fired && step === failAt) {
            fired = true;
            throw new Error(`fail:${step}`);
          }
        },
      });

      try {
        await service.updateRemoteWorkspace({
          workspaceId: connected.id,
          url: 'wss://new.example.test',
          token: 'new-token',
          remoteWorkspaceId: 'new-id',
        });
      } catch {}

      const resolved = await service.resolveRemoteWorkspaceConnection(connected.id);
      const oldComplete = resolved.url === 'wss://old.example.test/'
        && resolved.remoteWorkspaceId === 'old-id'
        && resolved.token === 'old-token';
      const newComplete = resolved.url === 'wss://new.example.test/'
        && resolved.remoteWorkspaceId === 'new-id'
        && resolved.token === 'new-token';
      expect(oldComplete || newComplete, failAt).toBe(true);
    }
  });

  it('appends the registry last and never leaves a partial new binding at any failpoint', async () => {
    for (const failAt of REMOTE_BINDING_MUTATION_STEPS) {
      const configDir = makeConfigDir();
      const credentials = new MemoryCredentials();
      const service = createWorkspaceService({
        configDir,
        credentialManager: credentials,
        remoteGateway: gateway(),
        remoteBindingFailpoint(step) {
          if (step === failAt) throw new Error(`fail:${step}`);
        },
      });

      let result: Awaited<ReturnType<typeof service.connectRemoteWorkspace>> | undefined;
      try {
        result = await service.connectRemoteWorkspace({
          name: 'Remote', url: 'wss://remote.example.test', token: 'new-token', remoteWorkspaceId: 'remote-id',
        });
      } catch {}

      const listed = await service.list();
      expect(listed.length === 0 || listed.length === 1, failAt).toBe(true);
      if (listed.length === 0) {
        expect([...credentials.remoteTokens.keys()].filter(key => !key.startsWith('__remote-binding-'))).toEqual([]);
      } else {
        expect(result?.id ?? listed[0]!.id).toBe(listed[0]!.id);
        expect(await service.resolveRemoteWorkspaceConnection(listed[0]!.id)).toMatchObject({
          url: 'wss://remote.example.test/', remoteWorkspaceId: 'remote-id', token: 'new-token',
        });
      }
      expect(existsSync(join(configDir, '.remote-bindings'))
        ? [...credentials.remoteTokens.keys()].some(key => key.startsWith('__remote-binding-'))
        : false).toBe(false);
    }
  });

  it('returns a retryable non-secret diagnostic when remote creation succeeds but local commit fails', async () => {
    const configDir = makeConfigDir();
    const credentials = new MemoryCredentials();
    const remoteGateway = gateway();
    const service = createWorkspaceService({
      configDir,
      credentialManager: credentials,
      remoteGateway,
      remoteBindingFailpoint(step) {
        if (step === 'before-registry-swap') throw new Error('local commit failed');
      },
    });

    const error = await service.createWorkspaceOnRemote({
      url: 'wss://remote.example.test', token: 'distinctive-remote-secret', name: 'Remote created',
    }).catch(value => value);

    expect(error).toBeInstanceOf(RemoteWorkspaceLocalCommitError);
    expect(error.remoteWorkspaceId).toBe('remote-created');
    expect(JSON.stringify(error)).not.toContain('distinctive-remote-secret');
    expect(remoteGateway.createWorkspace).toHaveBeenCalledTimes(1);
  });

  it('recovers an interrupted update journal without exposing a mixed connection', async () => {
    const configDir = makeConfigDir();
    const credentials = new MemoryCredentials();
    const remoteGateway = gateway();
    const setup = createWorkspaceService({ configDir, credentialManager: credentials, remoteGateway });
    const connected = await setup.connectRemoteWorkspace({
      name: 'Remote', url: 'wss://old.example.test', token: 'old-token', remoteWorkspaceId: 'old-id',
    });
    const interrupted = createWorkspaceService({
      configDir,
      credentialManager: credentials,
      remoteGateway,
      remoteBindingFailpoint(step) {
        if (step === 'after-credential-store-swap') throw new Error('process stopped');
      },
    });
    (interrupted as unknown as { recoverRemoteBindingJournal(): Promise<never> }).recoverRemoteBindingJournal =
      async () => { throw new Error('process stopped'); };

    await expect(interrupted.updateRemoteWorkspace({
      workspaceId: connected.id,
      url: 'wss://new.example.test',
      token: 'new-token',
      remoteWorkspaceId: 'new-id',
    })).rejects.toThrow('process stopped');

    const transactionId = readdirSync(join(configDir, '.remote-bindings'))[0]!;
    const journalJson = readFileSync(
      join(configDir, '.remote-bindings', transactionId, 'journal.json'),
      'utf8',
    );
    expect(journalJson).not.toContain('old-token');
    expect(journalJson).not.toContain('new-token');

    const recovered = createWorkspaceService({ configDir, credentialManager: credentials, remoteGateway });
    expect(await recovered.resolveRemoteWorkspaceConnection(connected.id)).toEqual({
      localWorkspaceId: connected.id,
      url: 'wss://new.example.test/',
      remoteWorkspaceId: 'new-id',
      token: 'new-token',
    });
  });

  it('rolls back an interrupted unregistered remote binding on the next open', async () => {
    const configDir = makeConfigDir();
    const credentials = new MemoryCredentials();
    const remoteGateway = gateway();
    const interrupted = createWorkspaceService({
      configDir,
      credentialManager: credentials,
      remoteGateway,
      remoteBindingFailpoint(step) {
        if (step === 'before-registry-swap') throw new Error('process stopped');
      },
    });
    (interrupted as unknown as { recoverRemoteBindingJournal(): Promise<never> }).recoverRemoteBindingJournal =
      async () => { throw new Error('process stopped'); };

    await expect(interrupted.connectRemoteWorkspace({
      name: 'Interrupted',
      url: 'wss://remote.example.test',
      token: 'new-token',
      remoteWorkspaceId: 'remote-id',
    })).rejects.toThrow('process stopped');

    const recovered = createWorkspaceService({ configDir, credentialManager: credentials, remoteGateway });
    expect(await recovered.list()).toEqual([]);
    expect([...credentials.remoteTokens.keys()]).toEqual([]);
  });
});
