/**
 * P1 fixture-hygiene checks (session side) for the frozen workspace/project
 * contract corpus: equal session ID strings and equal project paths must never
 * merge state across Workspaces. Behavioral enforcement lands in P3/P4; here we
 * only freeze the identity keys the later phases join on.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSessionKey } from '@nessy-agent/shared/sessions';
import { resolveProjectIdentity } from '@nessy-agent/shared/projects/project-identity';

const SHARED_SESSION_ID = 's-shared';
const WORKSPACE_IDS = ['ws-alpha', 'ws-beta'] as const;

let baseDir: string;
let projectRoot: string;

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'nessy-session-contract-corpus-'));
  projectRoot = join(baseDir, 'shared-project');
  mkdirSync(projectRoot, { recursive: true });
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('workspace project contract corpus (sessions)', () => {
  it('fixture equal session IDs across workspaces produce distinct composite keys', () => {
    const keys = WORKSPACE_IDS.map(workspaceId =>
      encodeSessionKey({ workspaceId, sessionId: SHARED_SESSION_ID }));
    expect(new Set(keys).size).toBe(WORKSPACE_IDS.length);
  });

  it('fixture one project referenced by two workspaces keeps one ProjectKey but distinct policy scope tuples', async () => {
    const first = await resolveProjectIdentity(projectRoot);
    const second = await resolveProjectIdentity(projectRoot);
    expect(second.projectKey).toBe(first.projectKey);

    const scopeTuples = WORKSPACE_IDS.map(workspaceId => `${workspaceId}\u0000${first.projectKey}`);
    expect(new Set(scopeTuples).size).toBe(WORKSPACE_IDS.length);
  });
});
