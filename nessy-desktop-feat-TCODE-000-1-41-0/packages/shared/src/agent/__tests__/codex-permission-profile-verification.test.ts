/**
 * P2.330 — a rejected codex permission profile FAILS OPEN, silently, and the
 * session still looks sandboxed. This is the check that refuses to let it.
 *
 * THE DEFECT, measured 2026-08-28 on `rust-v0.148.0`
 * (`docs/superpowers/specs/2026-08-28-codex-sandbox-enforcement.md` §4): an
 * `extends` the binary rejects produces **no RPC error**. It writes
 * `Invalid configuration; using defaults` to **stderr only** and discards the
 * WHOLE `config.toml` — our `deny` on `credentials.enc` with it (F1.1057 later dropped
 * that deny; the profile's protected-path and user deniedPaths entries go the same way). codex's own
 * default `workspace-write` then keeps refusing outside writes and network, so
 * from every angle EXCEPT the credential read the session still looks
 * sandboxed. The negative-control arm of that measurement read a decoy secret
 * while `permissionProfile/list` reported the profile `allowed: false`.
 *
 * `[doc:codex]` — `learn.chatgpt.com/docs/permissions.md#configuration-spec`, on
 * `permissions.<name>.extends`, verbatim:
 *
 *   "Starts this profile from another named profile or the built-in
 *   `:read-only` or `:workspace` profile. Codex rejects `:danger-full-access`,
 *   unknown parents, and inheritance cycles."
 *
 * The page says Codex REJECTS. It does not promise the rejection is legible to a
 * client, and measurement says it is not — so an `extends` that is accepted on
 * this pin can be rejected by a future one with no change of ours, and the only
 * in-band signal is the one asserted here.
 *
 * WHY THE TESTS ARE ASYMMETRIC. `allowed: false` is the one unambiguous state
 * (either the binary refused the profile, or managed requirements forbid
 * selecting it — in BOTH the filesystem deny is not in force), so it is the only
 * one that refuses. Everything else is "we do not know", which is not evidence
 * of a downgrade: refusing on a missing method or a transport hiccup would brick
 * codex sessions on version drift, a bigger hole than the one being closed. That
 * is the same degradation contract `probeCodexConfigRequirements` follows ten
 * lines above the call site.
 */
import { describe, expect, it } from 'bun:test';
import { CodexAgent } from '../codex-agent.ts';
import { createMockBackendConfig } from './test-utils.ts';
import type { BackendConfig } from '../backend/types.ts';

/** The profile name the config writer actually emits (`nessy_runtime`). */
const OUR_PROFILE = 'nessy_runtime';

function codexAgent(): { agent: CodexAgent; debug: string[] } {
  const debug: string[] = [];
  const agent = new CodexAgent({
    ...createMockBackendConfig(),
    provider: 'codex-runtime',
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig);
  (agent as unknown as { onDebug?: (m: string) => void }).onDebug = (message: string) => {
    debug.push(message);
  };
  return { agent, debug };
}

/** Drive the private verifier against a fake app-server. */
async function verify(
  agent: CodexAgent,
  request: (method: string, params?: unknown) => Promise<unknown>,
): Promise<void> {
  await (agent as unknown as {
    verifyPermissionProfileAccepted(client: { request: typeof request }): Promise<void>;
  }).verifyPermissionProfileAccepted({ request });
}

describe('P2.330 — a rejected permission profile must not start a session', () => {
  it('REFUSES when the binary reports our profile as not allowed', async () => {
    const { agent, debug } = codexAgent();
    await expect(verify(agent, async () => ({
      data: [
        { id: ':read-only', allowed: true },
        { id: ':workspace', allowed: true },
        { id: OUR_PROFILE, allowed: false },
      ],
      nextCursor: null,
    }))).rejects.toThrow(/refused the "nessy_runtime" permission profile/);
    // The message has to name the CONSEQUENCE, not just the state: the whole
    // point of the row is that every other surface still looks intact.
    await expect(verify(agent, async () => ({
      data: [{ id: OUR_PROFILE, allowed: false }],
      nextCursor: null,
    }))).rejects.toThrow(/protected-path entries and every deniedPaths entry of yours/);
    // F1.1057 — the host's own credential deny is no longer in the profile, so the refusal
    // must not claim it is what was lost.
    const refusal = await verify(agent, async () => ({ data: [{ id: OUR_PROFILE, allowed: false }], nextCursor: null }))
      .then(() => '', (error: Error) => error.message);
    expect(refusal).toContain('refused the "nessy_runtime" permission profile');
    expect(refusal).not.toContain('credentials store');
    // RE-PINNED (F1.59 CI, MR !49 row 9). The refusal says nothing on the debug
    // channel — no "starts unverified", no degrade line. The ONE line allowed is
    // F1.664's (`c6bca9443`) `[protectedPaths] … contains the Nessy config dir`,
    // which `configDirProjection` emits while the verifier builds the declared
    // profile (`codexDeniedReadPaths`), before it asks, whenever a codex
    // writable root holds the config dir: `$TMPDIR` under the isolate preload on
    // macOS, `/tmp` on the Linux runner. It is the profile builder's line, not
    // the verifier's, so it is set aside by its exact prefix and nothing else is.
    const projectionLine = '[protectedPaths] a codex writable root contains the Nessy config dir ';
    expect(debug.filter(line => !line.startsWith(projectionLine))).toEqual([]);
  });

  it('accepts, and says ACCEPTED-not-enforced, when the profile is in force', async () => {
    const { agent, debug } = codexAgent();
    const methods: string[] = [];
    await verify(agent, async (method) => {
      methods.push(method);
      return { data: [{ id: OUR_PROFILE, allowed: true }], nextCursor: null };
    });
    expect(methods).toEqual(['permissionProfile/list']);
    // RE-ANCHORED (W3-a, 2026-09-03). This pin read
    // `codex permission profile "<p>" accepted` and went red at `850443b69`,
    // which changed the line ON PURPOSE: P3.308 measured on the real Linux
    // binary that a profile reported `allowed: true` can still fail to build a
    // sandbox, so the line stopped claiming "the credentials deny is in force"
    // — something this check cannot observe. The pin now asserts the SURVIVING
    // half (the profile was accepted) AND the distinction, so a future edit
    // cannot quietly put the enforcement claim back.
    //
    // The non-empty guard is deliberate and is G-1's lesson from a sibling pin
    // that failed OPEN: an assertion over an EMPTY debug array would make the
    // two `toContain`s below vacuous rather than red.
    expect(debug.length).toBeGreaterThan(0);
    const accepted = debug.join('\n');
    expect(accepted).toContain(`codex permission profile "${OUR_PROFILE}" was ACCEPTED`);
    expect(accepted).toContain('it is not enforcement');
  });

  it('passes `cwd`, because that is what resolves the project config layers', () => {
    // `PermissionProfileListParams.cwd` — "Optional working directory to resolve
    // project config layers". Without it the answer describes a different layer
    // stack than the session runs under, which would make a green check
    // meaningless rather than merely incomplete.
    const { agent } = codexAgent();
    const seen: unknown[] = [];
    return verify(agent, async (_method, params) => {
      seen.push(params);
      return { data: [{ id: OUR_PROFILE, allowed: true }], nextCursor: null };
    }).then(() => {
      expect(seen).toEqual([{ cwd: (agent as unknown as { workingDirectory: string }).workingDirectory }]);
    });
  });

  it('DEGRADES rather than refusing when the method is not there to answer', async () => {
    // An app-server that does not know `permissionProfile/list` is a downgraded
    // or substituted artifact, not a downgraded sandbox. "We do not know" must
    // not read as "we know it is broken".
    const { agent, debug } = codexAgent();
    await verify(agent, async () => {
      throw new Error('unknown variant `permissionProfile/list`');
    });
    expect(debug.some(line => line.includes('did not answer')
      && line.includes('starts unverified'))).toBe(true);
  });

  it('DEGRADES when the listing does not carry our profile at all', async () => {
    const { agent, debug } = codexAgent();
    await verify(agent, async () => ({
      data: [{ id: ':workspace', allowed: true }],
      nextCursor: null,
    }));
    expect(debug.some(line => line.includes(`did not list "${OUR_PROFILE}"`))).toBe(true);
  });

  it('DEGRADES on a listing with no data at all, rather than throwing on a shape', async () => {
    const { agent, debug } = codexAgent();
    await verify(agent, async () => ({}));
    expect(debug.some(line => line.includes(`did not list "${OUR_PROFILE}"`))).toBe(true);
  });
});

/**
 * F1.751 — a TRUSTED project's `.codex/config.toml` can ADD entries to this host's `nessy_runtime`
 * profile: codex merges config tables key by key (`merge_toml_values`, `codex-rs/config/src/merge.rs`
 * at rust-v0.159.3) and `permissions` is not on `PROJECT_LOCAL_CONFIG_DENYLIST`, so the request layer
 * that restates the profile cannot take a project's extra key back out. Measured on the shipped 0.159.3
 * (BK-8, `work/bk-8/f1751-probe.ts`): a project adding `"<outside>" = "write"` put that folder in the
 * thread's `writableRoots` and an agent command's write there landed (exit 0); the control without it was
 * refused. `config/read { cwd, includeLayers: true }` shows the project layer — the channel read here.
 * DECIDED (TRANSPARENT and SIMPLE, QUESTIONS.md): the session SAYS so; it does not refuse.
 */
describe('F1.751 — a trusted project layer that adds to the nessy_runtime profile is said', () => {
  type Layer = { name: { type: string; dotCodexFolder?: string }; config: unknown; disabledReason: string | null };
  async function note(agent: CodexAgent, request: (method: string, params?: unknown) => Promise<unknown>): Promise<void> {
    await (agent as unknown as {
      noteProjectPermissionProfileAdditions(client: { request: typeof request }): Promise<void>;
    }).noteProjectPermissionProfileAdditions({ request });
  }
  const notices = (agent: CodexAgent): string[] => (agent as unknown as { pendingServerWarningNotices: string[] }).pendingServerWarningNotices;
  const project = (config: unknown, disabledReason: string | null = null): Layer =>
    ({ name: { type: 'project', dotCodexFolder: '/work/proj/.codex' }, config, disabledReason });

  it('a project layer adding a filesystem entry to nessy_runtime: one notice naming the folder and the entry', async () => {
    const { agent } = codexAgent();
    const seen: unknown[] = [];
    await note(agent, async (method, params) => {
      seen.push([method, params]);
      return { config: {}, origins: {}, layers: [project({ permissions: { [OUR_PROFILE]: { filesystem: { '/work/outside': 'write' } } } })] };
    });
    expect(seen).toEqual([['config/read', { cwd: (agent as unknown as { workingDirectory: string }).workingDirectory, includeLayers: true }]]);
    expect(notices(agent)).toHaveLength(1);
    expect(notices(agent)[0]).toContain('/work/proj/.codex');
    expect(notices(agent)[0]).toContain('/work/outside');
  });

  it('CONTROL — a project layer with no nessy_runtime table, and a DISABLED (untrusted) one that has it: silent', async () => {
    const { agent } = codexAgent();
    await note(agent, async () => ({
      config: {}, origins: {}, layers: [
        project({ model_reasoning_effort: 'high', permissions: { other_profile: { filesystem: { '/x': 'write' } } } }),
        project({ permissions: { [OUR_PROFILE]: { filesystem: { '/work/outside': 'write' } } } }, 'project is not trusted'),
        { name: { type: 'user' }, config: { permissions: { [OUR_PROFILE]: { filesystem: { '/y': 'deny' } } } }, disabledReason: null },
      ],
    }));
    expect(notices(agent)).toEqual([]);
  });

  it('DEGRADES when config/read does not answer: a debug line, no notice, no throw', async () => {
    const { agent, debug } = codexAgent();
    await note(agent, async () => { throw new Error('unknown variant `config/read`'); });
    expect(notices(agent)).toEqual([]);
    expect(debug.some(line => line.includes('config/read did not answer'))).toBe(true);
  });
});
