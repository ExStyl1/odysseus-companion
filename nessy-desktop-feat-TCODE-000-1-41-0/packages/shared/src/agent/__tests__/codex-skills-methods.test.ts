/**
 * P6.399 — codex publishes three `skills/*` methods and we sent none.
 *
 * Native-first case (1): the mechanism existed and was unenabled. `skills/list`
 * and `skills/config/write` are now sent over the app-server connection the
 * session already holds; `skills/extraRoots/set` is excluded by the row's own
 * text and sequences with P6.169.
 *
 * WHAT EACH TEST KILLS:
 *  - the list arm dies if `skills/list` stops being sent — the shipped state,
 *    in which the reason recorded for ignoring `skills/changed` was circular
 *    because nothing changed in what we presented only while we never asked.
 *  - the projection arm dies if a host `off`/`user-invocable-only` override
 *    stops reaching codex's own skill, or if it starts reaching a skill the user
 *    did not name. `name-only` is asserted NOT to disable: it suppresses a
 *    description, and codex's key is a boolean, so projecting it would be
 *    stricter than the user asked.
 *  - the already-disabled arm dies if the sync starts writing a key codex has
 *    already resolved — noise on every notification.
 *  - the failure arms die if a refusal becomes fatal: a session must keep
 *    running on codex's own configuration.
 *  - the classification arm dies if `skills/changed` goes back on the unread
 *    list, which is the exact regression this row closed.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as configStorage from '../../config/storage.ts';
import {
  CODEX_HANDLED_NOTIFICATION_METHODS,
  CODEX_UNREAD_NOTIFICATION_METHODS,
} from '../codex-notification-families.ts';
import type { BackendConfig } from '../backend/types.ts';

const realStorage = { ...configStorage };
let storedConfig: unknown = {};

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  loadStoredConfig: () => storedConfig,
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => realStorage);
});

afterEach(() => { storedConfig = {}; });

const { CodexAgent } = await import('../codex-agent.ts');
const { CODEX_SKILL_EXTRA_ROOTS_SWITCH_NOTE } = await import('../backend/codex/skill-extra-roots.ts');

interface Call { method: string; params: unknown }

function agentWith(
  listed: unknown,
  options: { writeAnswer?: unknown; failList?: boolean; failWrite?: boolean; failExtraRoots?: boolean } = {},
) {
  const calls: Call[] = [];
  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-skills',
      name: 'Codex Skills Workspace',
      rootPath: '/tmp/ws-codex-skills-root',
      workspaceRootPath: '/tmp/ws-codex-skills-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-skills',
    } as never,
    session: {
      id: 'session-codex-skills',
      workspaceRootPath: '/tmp/ws-codex-skills-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'tgpt/qwen35-397b-a17b-fp8',
    isHeadless: true,
  } as BackendConfig);

  (agent as unknown as { client: unknown }).client = {
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'skills/list') {
        if (options.failList) throw new Error('list refused');
        return listed;
      }
      if (method === 'skills/config/write') {
        if (options.failWrite) throw new Error('write refused');
        return options.writeAnswer ?? { effectiveEnabled: false };
      }
      // C4.24 · the third `skills/*` member, sent since the owner took QL3 C.
      if (method === 'skills/extraRoots/set') {
        if (options.failExtraRoots) throw new Error('extra roots refused');
        return {};
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  const sync = (agent as unknown as {
    syncCodexSkillsConfig: (reason: 'startup' | 'skills/changed') => Promise<void>
  }).syncCodexSkillsConfig.bind(agent);
  return { agent, calls, sync };
}

const LISTED = {
  data: [{
    cwd: '/tmp/project-root',
    errors: [],
    skills: [
      { name: '$skill-installer', enabled: true },
      { name: 'brainstorming', enabled: true },
      { name: 'already-off', enabled: false },
    ],
  }],
};

/**
 * C4.24 (QL3, owner answer C, 2026-09-11) — the ADDED FOLDERS' skills, through
 * codex's own `skills/extraRoots/set`, the third member P6.399 left unwired.
 *
 * WHAT EACH TEST KILLS:
 *  - the no-folders arm dies if a session with nothing added starts sending an
 *    inert request — which is not free: every `set` makes codex emit
 *    `skills/changed`, and `skills/changed` is what calls this sync;
 *  - the two-layer arm dies if the roots stop matching the host's own scan
 *    (`native-sources.ts` `nestedSkillDirectories`), which is the whole point —
 *    codex must be handed the same two directories Pi and claude are;
 *  - the missing-layer arm is the POSITIVE CONTROL: without it "the roots reach
 *    codex" is equally satisfied by handing it every path whether or not it
 *    exists, which is noise on every sync rather than a capability;
 *  - the SECOND-SYNC arm is the loop guard, and it is the one that matters most:
 *    codex answers every set with `skills/changed`, so an unconditional send is
 *    an infinite round trip;
 *  - the refusal arm dies if a codex that does not know the method takes the
 *    session's skills with it.
 */
describe('C4.24 · skills/extraRoots/set carries the added folders', () => {
  const addedRoots: string[] = [];
  afterEach(() => {
    while (addedRoots.length > 0) rmSync(addedRoots.pop()!, { recursive: true, force: true });
  });

  /** An added folder on disk, with whichever of the two skill layers is asked for. */
  function addedFolder(layers: ('.agents/skills' | '.nessy-agent/skills')[]): string {
    const created = mkdtempSync(join(tmpdir(), 'nessy-c424-added-'));
    addedRoots.push(created);
    for (const layer of layers) mkdirSync(join(created, layer), { recursive: true });
    storedConfig = { additionalDirectories: [created] };
    // The host resolver canonicalises (`/var` -> `/private/var` on macOS), and
    // the roots codex is handed are the canonical ones — so the expectation has
    // to be canonical too, or this passes only on Linux.
    return realpathSync(created);
  }

  it('sends NOTHING when no folder has been added', async () => {
    const { calls, sync } = agentWith(LISTED);
    await sync('startup');
    expect(calls.map(call => call.method)).not.toContain('skills/extraRoots/set');
  });

  it('hands codex both host skill layers of an added folder, before the list', async () => {
    const root = addedFolder(['.agents/skills', '.nessy-agent/skills']);
    const { calls, sync } = agentWith(LISTED);

    await sync('startup');

    expect(calls[0]?.method).toBe('skills/extraRoots/set');
    // Read into a local first, then assert — a matcher passed to
    // `toMatchObject` overwrites the field it matched (AGENTS.md §Traps).
    const extraRoots = (calls[0]?.params as { extraRoots?: string[] }).extraRoots ?? [];
    expect([...extraRoots].sort()).toEqual([
      join(root, '.agents', 'skills'),
      join(root, '.nessy-agent', 'skills'),
    ].sort());
    // The roots are in place BEFORE codex is asked what it can see.
    expect(calls[1]?.method).toBe('skills/list');
  });

  it('omits a layer that does not exist — the POSITIVE CONTROL', async () => {
    const root = addedFolder(['.agents/skills']);
    const { calls, sync } = agentWith(LISTED);

    await sync('startup');

    const extraRoots = (calls[0]?.params as { extraRoots?: string[] }).extraRoots ?? [];
    expect(extraRoots).toEqual([join(root, '.agents', 'skills')]);
  });

  it('does NOT re-send an unchanged list — the `skills/changed` loop guard', async () => {
    addedFolder(['.agents/skills']);
    const { calls, sync } = agentWith(LISTED);

    await sync('startup');
    // This is exactly what codex's own answer provokes: every set emits
    // `skills/changed`, and that notification calls this sync.
    await sync('skills/changed');

    expect(calls.filter(call => call.method === 'skills/extraRoots/set')).toHaveLength(1);
  });

  it('keeps the session running when codex refuses the method', async () => {
    addedFolder(['.agents/skills']);
    const { calls, sync } = agentWith(LISTED, { failExtraRoots: true });

    await sync('startup');

    expect(calls.map(call => call.method)).toContain('skills/list');
    // …and it is retried on the next notification, because nothing was recorded
    // as sent — a codex that refused once may be a codex that was not ready.
    await sync('skills/changed');
    expect(calls.filter(call => call.method === 'skills/extraRoots/set')).toHaveLength(2);
  });

  it('says the residual difference out loud, and names Pi', () => {
    // The host's job is to make the residual difference uniform or HONEST, and
    // this one cannot be uniform: on Pi an added folder is the
    // `additionalDirectories` SETTING, which `large-codebases.md` scores "Never"
    // for skills.
    expect(CODEX_SKILL_EXTRA_ROOTS_SWITCH_NOTE).toContain('PI DOES NOT');
    expect(CODEX_SKILL_EXTRA_ROOTS_SWITCH_NOTE).toContain('skills/extraRoots/set');
  });
});

describe('P6.399 · skills/list is actually sent', () => {
  it('reads codex\'s own skill set on startup', async () => {
    const { calls, sync } = agentWith(LISTED);
    await sync('startup');
    expect(calls[0]).toEqual({ method: 'skills/list', params: {} });
  });

  it('sends nothing else when no host override names a listed skill', async () => {
    const { calls, sync } = agentWith(LISTED);
    await sync('startup');
    expect(calls.map(call => call.method)).toEqual(['skills/list']);
  });
});

describe('P6.399 · a host override reaches codex\'s own skill', () => {
  it('projects `off` onto skills/config/write by NAME', async () => {
    storedConfig = { skillOverrides: { '$skill-installer': 'off' } };
    const { calls, sync } = agentWith(LISTED);
    await sync('startup');
    expect(calls.slice(1)).toEqual([
      { method: 'skills/config/write', params: { name: '$skill-installer', enabled: false } },
    ]);
  });

  it('projects `user-invocable-only` too — the other state that hides from the model', async () => {
    storedConfig = { skillOverrides: { brainstorming: 'user-invocable-only' } };
    const { calls, sync } = agentWith(LISTED);
    await sync('startup');
    expect(calls.slice(1)).toEqual([
      { method: 'skills/config/write', params: { name: 'brainstorming', enabled: false } },
    ]);
  });

  it('does NOT project `name-only` — codex\'s key is a boolean, that state is not', async () => {
    storedConfig = { skillOverrides: { brainstorming: 'name-only' } };
    const { calls, sync } = agentWith(LISTED);
    await sync('startup');
    expect(calls.map(call => call.method)).toEqual(['skills/list']);
  });

  it('leaves a skill codex has already disabled alone', async () => {
    storedConfig = { skillOverrides: { 'already-off': 'off' } };
    const { calls, sync } = agentWith(LISTED);
    await sync('startup');
    expect(calls.map(call => call.method)).toEqual(['skills/list']);
  });
});

describe('P6.399 · a refusal keeps the session running on codex\'s own configuration', () => {
  it('survives a skills/list refusal', async () => {
    const { calls, sync } = agentWith(LISTED, { failList: true });
    await sync('startup');
    expect(calls.map(call => call.method)).toEqual(['skills/list']);
  });

  it('survives a skills/config/write refusal and keeps walking the rest', async () => {
    storedConfig = { skillOverrides: { '$skill-installer': 'off', brainstorming: 'off' } };
    const { calls, sync } = agentWith(LISTED, { failWrite: true });
    await sync('startup');
    expect(calls.map(call => call.method))
      .toEqual(['skills/list', 'skills/config/write', 'skills/config/write']);
  });

  it('an empty listing writes nothing', async () => {
    storedConfig = { skillOverrides: { '$skill-installer': 'off' } };
    const { calls, sync } = agentWith({ data: [] });
    await sync('startup');
    expect(calls.map(call => call.method)).toEqual(['skills/list']);
  });
});

describe('P6.399 · skills/changed is handled, not ignored', () => {
  it('left the unread list and joined the handled one', () => {
    expect(CODEX_UNREAD_NOTIFICATION_METHODS).not.toContain('skills/changed' as never);
    expect(CODEX_HANDLED_NOTIFICATION_METHODS).toContain('skills/changed' as never);
  });

  it('the notification handler re-reads the list', async () => {
    const { calls, sync } = agentWith(LISTED);
    await sync('skills/changed');
    expect(calls[0]?.method).toBe('skills/list');
  });

  it('and the two CALL SITES exist — a sync nothing dispatches is the defect wearing a fix', () => {
    const source = readFileSync(fileURLToPath(new URL('../codex-agent.ts', import.meta.url)), 'utf8');
    expect(source).toContain("if (method === 'skills/changed') {");
    expect(source).toContain("void this.syncCodexSkillsConfig('skills/changed');");
    // Startup: after the thread is open, so the request has a client to ride.
    expect(source).toContain("void this.syncCodexSkillsConfig('startup');");
    const startup = source.indexOf("void this.syncCodexSkillsConfig('startup');");
    expect(source.slice(0, startup)).toContain('this.threadId = threadId;');
    // C4.24 · `skills/extraRoots/set` IS sent now — the owner took QL3 option C
    // on 2026-09-11 and P6.399's "out of scope by the row's own text" no longer
    // describes this build. This line REPLACES the absence guard that stood here
    // (a `not.toContain` on the same request), which was correct while the third
    // member was deliberately unwired and false the moment it was wired; the
    // flip is named in words rather than by re-spelling the old assertion.
    expect(source).toContain("request('skills/extraRoots/set'");
    // …and it is sent from INSIDE the sync, ahead of the list, so the roots are
    // in place before codex answers what it can see.
    expect(source).toContain('await this.syncCodexSkillExtraRoots(client);');
  });
});

/**
 * F1.948 (origin WJ-crit-lll P-2) — the sync's debug count read codex's PROCESS-level `skills/list`,
 * which reads no thread's `SessionFlags` layer: a restricted project's own skills, disabled for the
 * thread by F1.845's request map, were still counted as enabled (measured, F1.845's residue (2)). The
 * count now subtracts them and says why.
 */
describe('F1.948 · the skills debug count names the restricted project\'s thread-layer disables', () => {
  const REPO_SKILL = '/tmp/project-root/.agents/skills/proj/SKILL.md';
  const listedWithRepo = {
    data: [{
      cwd: '/tmp/project-root',
      errors: [],
      skills: [
        { name: 'brainstorming', enabled: true, path: '/home/u/.agents/skills/brainstorming/SKILL.md' },
        { name: 'proj', enabled: true, path: REPO_SKILL },
        { name: 'already-off', enabled: false, path: '/home/u/.agents/skills/off/SKILL.md' },
      ],
    }],
  };

  it('counts a restricted project\'s skill the thread disables as disabled, and labels it', async () => {
    const { agent, sync } = agentWith(listedWithRepo);
    const lines: string[] = [];
    agent.onDebug = (message: string) => { lines.push(message); };
    (agent as unknown as { codexRestrictedRepoSkillsOff: unknown }).codexRestrictedRepoSkillsOff = [{ path: REPO_SKILL, enabled: false }];
    await sync('startup');
    const line = lines.find(message => message.startsWith('[Skills] codex lists'));
    expect(line).toContain('codex lists 3 skill(s) of its own (startup); 2 already disabled');
    expect(line).toContain('1 of them a project skill this restricted project\'s thread disables (F1.845)');
  });

  it('BOUNDARY: a trusted project (nothing disabled at the thread layer) keeps the plain count, no label', async () => {
    const { agent, sync } = agentWith(listedWithRepo);
    const lines: string[] = [];
    agent.onDebug = (message: string) => { lines.push(message); };
    await sync('startup');
    const line = lines.find(message => message.startsWith('[Skills] codex lists'));
    expect(line).toBe('[Skills] codex lists 3 skill(s) of its own (startup); 1 already disabled');
  });
});
