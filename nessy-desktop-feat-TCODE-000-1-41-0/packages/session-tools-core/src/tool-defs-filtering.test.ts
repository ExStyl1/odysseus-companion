import { describe, it, expect } from 'bun:test';
import {
  SESSION_TOOL_DEFS,
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT,
  getSessionToolDefs,
  getSessionToolNames,
  getSessionToolRegistry,
  getSessionSafeAllowedToolNames,
  getSessionSafeBlockedToolNames,
  getToolDefsAsJsonSchema,
  SpawnSessionSchema,
} from './tool-defs.ts';
import { AUTO_MEMORY_KINDS } from './memory-index.ts';

describe('externalStandaloneOnly filter (Codex external subprocess)', () => {
  const names = getSessionToolNames({ externalStandaloneOnly: true });

  it('keeps standalone registry tools with no host-callback dependency', () => {
    for (const keep of ['source_test', 'config_validate', 'transform_data', 'render_template', 'automation_list', 'automation_create', 'automation_update', 'automation_validate']) {
      expect(names.has(keep)).toBe(true);
    }
  });

  /**
   * P6.303 (1) — the THIRD exclusion mechanism, and the one a reader of the
   * other two cannot derive. `TodoWrite` is a standalone registry tool with no
   * host callback, so both cases around this one would keep it; it is withheld
   * because codex ships `update_plan` and the model was being offered two
   * checklists for one job.
   *
   * The claude control is the half that makes it a rule rather than a deletion:
   * the same tool, the same filter, the default projection — kept, because
   * claude has no native equivalent.
   */
  it('withholds the host checklist from codex alone, which has its own', () => {
    expect(SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT.has('TodoWrite')).toBe(true);
    expect(names.has('TodoWrite')).toBe(false);
    expect(getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true }).has('TodoWrite'))
      .toBe(false);
    // The bridge lifts host-callback exclusions and nothing else, so it must not
    // lift this one — the negative that separates the two mechanisms.
    expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has('TodoWrite')).toBe(false);
    // Controls: claude keeps it, and Pi's own subtraction (the four Task tools)
    // is unaffected by this one.
    expect(getSessionToolNames().has('TodoWrite')).toBe(true);
    expect(getSessionToolNames({ projection: 'pi' }).has('TodoWrite')).toBe(false);
  });

  it('excludes every callback-dependent / backend tool', () => {
    for (const drop of ['call_llm', 'spawn_session', 'browser_tool', 'SubmitPlan', 'source_oauth_trigger', 'source_google_oauth_trigger', 'source_credential_prompt', 'update_user_preferences', 'set_session_labels', 'set_session_status', 'send_agent_message', 'SlashCommand', 'BashOutput', 'plugin_plan_install', 'plugin_install', 'plugin_status', 'plugin_manage']) {
      expect(names.has(drop)).toBe(false);
    }
  });

  /**
   * P3.222 — `list_sessions` and `get_session_info` MOVED between the two rows
   * above, and the move is the row.
   *
   * They sat in the "no host-callback dependency" list, which was never true:
   * both read `ctx.listSessions` / `ctx.getSessionInfo`, host closures
   * `SessionManager` publishes into the per-session registry exactly as it
   * publishes `sendAgentMessage`. `createCodexContext` bound neither, so the
   * only thing this membership bought a codex session was the OFFER of two tools
   * that answered "not available in this context" on every call. They are named
   * here rather than folded into the list above so the correction is visible
   * rather than a silently shortened array.
   */
  it('withholds the roster pair, which was advertised on this surface and bound on none', () => {
    for (const name of ['list_sessions', 'get_session_info']) {
      expect(names.has(name)).toBe(false);
      expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name)).toBe(true);
    }
    // Its write sibling has always been withheld here, and the pair being
    // uniform on the surface is what the row is for.
    expect(names.has('send_agent_message')).toBe(false);
    // Positive control on the same set: the filter still keeps what it should.
    expect(names.has('source_test')).toBe(true);
  });

  it('the filtered set is exactly the registry tools minus the host-callback set', () => {
    for (const def of getSessionToolDefs({ externalStandaloneOnly: true })) {
      expect(def.executionMode).toBe('registry');
      expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(def.name)).toBe(false);
    }
  });

  it('getToolDefsAsJsonSchema honors externalStandaloneOnly for advertising', () => {
    const advertised = getToolDefsAsJsonSchema({ externalStandaloneOnly: true }).map(d => d.name);
    expect(advertised).toContain('source_test');
    expect(advertised).not.toContain('call_llm');
    expect(advertised).not.toContain('SubmitPlan');
    expect(advertised).not.toContain('Task');
    expect(advertised).not.toContain('plugin_plan_install');
    expect(advertised).not.toContain('plugin_install');
    expect(advertised).not.toContain('plugin_status');
    expect(advertised).not.toContain('plugin_manage');
  });

  // UB7.11 — the MCP prompt pair: read-only and Explore-safe (upstream
  // v0.15.1's `tool-defs-filtering.test.ts` arm, on our two tools — the resource
  // pair of upstream's four stays native / `pi-only` here, B4-06).
  it('MCP source prompt tools are read-only and Explore-safe', () => {
    const allowed = getSessionSafeAllowedToolNames({ prefix: 'mcp__session__' });
    for (const name of ['source_list_prompts', 'source_get_prompt']) {
      expect(allowed.has(`mcp__session__${name}`)).toBe(true);
      expect(SESSION_TOOL_DEFS.some(d => d.name === name && d.executionMode === 'registry' && d.readOnly === true)).toBe(true);
    }
  });

  // UB6.11 — the decide tool: OFFERED with the port, ABSENT without it, on the
  // ADVERTISED surfaces (getSessionToolNames/getToolDefsAsJsonSchema apply
  // isOfferedByHostPorts; getSessionToolDefs deliberately does not — the
  // classification must keep seeing the tool, the P3.276 lesson recorded on the
  // predicate). The default-OFF is the safety: no caller that has not thought
  // about the decision layer advertises a tool that can only refuse.
  it('UB6.11 — decide is offered only with decidePort, and is read-only and Explore-safe', () => {
    for (const base of [
      {},
      { projection: 'pi' as const },
      { externalStandaloneOnly: true, hostCallbackBridge: true },
    ]) {
      expect(getSessionToolNames(base).has('decide')).toBe(false);
      expect(getSessionToolNames({ ...base, decidePort: true }).has('decide')).toBe(true);
    }
    // read-only + Explore-safe, like every registry reader — and the
    // classification is NOT offer-gated (no options at all).
    const allowed = getSessionSafeAllowedToolNames({ prefix: 'mcp__session__' });
    expect(allowed.has('mcp__session__decide')).toBe(true);
    expect(SESSION_TOOL_DEFS.some(d => d.name === 'decide' && d.executionMode === 'registry' && d.readOnly === true)).toBe(true);
    // host-callback dependent: an external spawn WITHOUT the bridge never sees it.
    expect(getSessionToolNames({ externalStandaloneOnly: true, decidePort: true }).has('decide')).toBe(false);
  });
});

describe('plugin management tools registration', () => {
  it('registers all 4 tools with correct read-only vs mutating safeMode metadata', () => {
    const registry = getSessionToolRegistry();
    const planInstall = registry.get('plugin_plan_install');
    const install = registry.get('plugin_install');
    const status = registry.get('plugin_status');
    const manage = registry.get('plugin_manage');

    expect(planInstall).toMatchObject({ executionMode: 'registry', safeMode: 'allow', readOnly: true });
    expect(status).toMatchObject({ executionMode: 'registry', safeMode: 'allow', readOnly: true });
    expect(install).toMatchObject({ executionMode: 'registry', safeMode: 'block' });
    expect(install?.readOnly).not.toBe(true);
    expect(manage).toMatchObject({ executionMode: 'registry', safeMode: 'block' });
    expect(manage?.readOnly).not.toBe(true);
  });

  it('is excluded from the external standalone provider tool set (host-callback only)', () => {
    for (const name of ['plugin_plan_install', 'plugin_install', 'plugin_status', 'plugin_manage']) {
      expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(name)).toBe(true);
    }
  });
});

describe('session tool filtering helpers', () => {
  // P2.2 INVERTED the goal half of this row, the way T3 inverted the Monitor
  // row below. It used to read "keeps Task and Goal Pi-only": true while
  // `ctx.goalPort` was bound on the Pi path, and false once the host binds it
  // for every runtime in `SCHEDULED_DELIVERY_RUNTIMES`. `Task` is untouched and
  // stays as the positive control — the projection filter still withholds
  // something, so the goal pair's presence is a measurement.
  it('projects Goal off Pi-only while Task stays Pi-only and TodoWrite/SubmitPlan are unmoved', () => {
    const adjacent = getSessionToolDefs().map(def => def.name);
    const pi = getToolDefsAsJsonSchema({ prefix: 'mcp__session__', projection: 'pi' }).map(def => def.name);
    expect(adjacent).not.toContain('Task');
    expect(adjacent).toContain('GoalGet');
    expect(adjacent).toContain('Goal');
    expect(adjacent).toContain('TodoWrite');
    expect(adjacent).toContain('SubmitPlan');
    // R20: the legacy `Task` tool is no longer model-facing on Pi by default —
    // `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` replace it there. It comes
    // back under `NESSY_ENABLE_TASKS=0`; see handlers/task-tools.test.ts.
    expect(pi.filter(name => name === 'mcp__session__Task')).toHaveLength(0);
    expect(pi.filter(name => name === 'mcp__session__TaskCreate')).toHaveLength(1);
    // The projection WIDENED — the pair is still on Pi, and its safeMode
    // metadata is unchanged on both surfaces.
    expect(pi.filter(name => name === 'mcp__session__GoalGet')).toHaveLength(1);
    expect(pi.filter(name => name === 'mcp__session__Goal')).toHaveLength(1);
    for (const registry of [getSessionToolRegistry({ projection: 'pi' }), getSessionToolRegistry()]) {
      expect(registry.get('GoalGet')).toMatchObject({ safeMode: 'allow', readOnly: true });
      expect(registry.get('GoalGet')?.visibility).toBeUndefined();
      expect(registry.get('Goal')).toMatchObject({ safeMode: 'block' });
      expect(registry.get('Goal')?.visibility).toBeUndefined();
    }
  });
  // T3 INVERTED this row. It used to read "keeps Monitor Pi-only, because only
  // the Pi gate presents the identity its Bash rules need" — true until T2 built
  // the host-side `command` gate that every non-Pi start now passes through, at
  // which point the restriction was protecting nothing. What did NOT change is
  // the second half: Monitor's host capability is a callback, so it still
  // cannot reach the external standalone surface. Both halves are kept, so the
  // one that moved is visibly the one that moved.
  it('projects Monitor to Claude now that the gate is host-side, and still withholds it from Codex', () => {
    const adjacent = getSessionToolDefs().map(def => def.name);
    const pi = getToolDefsAsJsonSchema({ prefix: 'mcp__session__', projection: 'pi' }).map(def => def.name);
    expect(adjacent).toContain('Monitor');
    expect(pi.filter(name => name === 'mcp__session__Monitor')).toHaveLength(1);
    expect(getSessionToolRegistry({ projection: 'pi' }).get('Monitor'))
      .toMatchObject({ safeMode: 'block' });
    expect(getSessionToolRegistry({ projection: 'pi' }).get('Monitor')?.visibility).toBeUndefined();
    expect(getSessionToolNames({ externalStandaloneOnly: true }).has('Monitor')).toBe(false);
  });

  it('includes automation management tools in the canonical registry', () => {
    const names = SESSION_TOOL_DEFS.map(def => def.name);

    expect(names).toContain('automation_list');
    expect(names).toContain('automation_create');
    expect(names).toContain('automation_update');
    expect(names).toContain('automation_validate');
  });

  it('excludes developer feedback tool when includeDeveloperFeedback is false', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('includes developer feedback tool when includeDeveloperFeedback is true', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: true });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(true);
  });

  it('name set and registry stay aligned for filtered output', () => {
    const names = getSessionToolNames({ includeDeveloperFeedback: false });
    const registry = getSessionToolRegistry({ includeDeveloperFeedback: false });

    expect(registry.has('send_developer_feedback')).toBe(false);
    expect(names.has('send_developer_feedback')).toBe(false);

    for (const name of names) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('json schema conversion respects includeDeveloperFeedback filter', () => {
    const defs = getToolDefsAsJsonSchema({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('all canonical session tools declare safeMode metadata', () => {
    for (const def of SESSION_TOOL_DEFS) {
      expect(def.safeMode === 'allow' || def.safeMode === 'block').toBe(true);
    }
  });

  it('safe-mode helper sets classify expected tools', () => {
    const allowed = getSessionSafeAllowedToolNames();
    const blocked = getSessionSafeBlockedToolNames();

    expect(allowed.has('send_developer_feedback')).toBe(true);
    expect(allowed.has('SlashCommand')).toBe(true);
    expect(allowed.has('BashOutput')).toBe(true);
    expect(allowed.has('call_llm')).toBe(true);
    expect(allowed.has('browser_tool')).toBe(true);
    expect(allowed.has('script_sandbox')).toBe(true);
    expect(allowed.has('TodoWrite')).toBe(true);
    expect(allowed.has('automation_list')).toBe(true);
    expect(allowed.has('automation_validate')).toBe(true);

    expect(blocked.has('source_oauth_trigger')).toBe(true);
    expect(blocked.has('source_credential_prompt')).toBe(true);
    expect(blocked.has('remember')).toBe(true);
    expect(blocked.has('spawn_session')).toBe(true);
    expect(blocked.has('automation_create')).toBe(true);
    expect(blocked.has('automation_update')).toBe(true);

    // UA6.3 (v0.13.4 tool-defs-filtering.test.ts, Apache-2.0) — Pages: reads are Plan-safe, mutations are not
    expect(allowed.has('list_pages')).toBe(true);
    expect(allowed.has('get_page')).toBe(true);
    expect(blocked.has('create_page')).toBe(true);
    expect(blocked.has('update_page')).toBe(true);
    expect(blocked.has('write_page_data')).toBe(true);
    expect(blocked.has('delete_page')).toBe(true);
  });

  it('safe-mode helpers support MCP prefixing', () => {
    const allowedPrefixed = getSessionSafeAllowedToolNames({ prefix: 'mcp__session__' });
    const blockedPrefixed = getSessionSafeBlockedToolNames({ prefix: 'mcp__session__' });

    expect(allowedPrefixed.has('mcp__session__send_developer_feedback')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__SlashCommand')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__BashOutput')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__call_llm')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__script_sandbox')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__TodoWrite')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__automation_list')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__automation_validate')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__source_oauth_trigger')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__remember')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__spawn_session')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__automation_create')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__automation_update')).toBe(true);
  });
});

/**
 * P6.619 — the `type` field P6.389 built a reader for was in no schema, so no
 * model could send it. The assertion is on the EMITTED JSON Schema rather than
 * on the zod object, because emitting is the only thing `inputSchema` is used
 * for (`session-mcp-server/src/index.ts` builds the tool list from it and hands
 * handlers the raw arguments) — so the emitted document is exactly what a model
 * and a strict-schema provider see.
 */
describe('remember schema — the documented note kind is describable', () => {
  const remember = getToolDefsAsJsonSchema().find(def => def.name === 'remember');
  const properties = (remember?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const type = properties?.type as { enum?: string[]; description?: string } | undefined;

  it('emits the four documented kinds, and exactly those', () => {
    // Not a restated list: the same constant the handler's refusal message is
    // built from, so a fifth kind added in one place fails here rather than
    // silently disagreeing with the other.
    expect(type?.enum).toEqual([...AUTO_MEMORY_KINDS]);
    expect(type?.description).toContain('type');
  });

  it('leaves the field optional, and leaves `memory` the only required one', () => {
    // The kind is a label on the note, never a gate on remembering it — an
    // untyped write must stay valid, which is the contract `RememberArgs`
    // states and the handler implements.
    const required = (remember?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
    expect(required).toEqual(['memory']);
  });
});

describe('spawn_session schema', () => {
  it('accepts every permission mode override', () => {
    for (const permissionMode of ['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      const result = SpawnSessionSchema.safeParse({ prompt: 'Run this', permissionMode });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissionMode).toBe(permissionMode);
      }
    }
  });
});
