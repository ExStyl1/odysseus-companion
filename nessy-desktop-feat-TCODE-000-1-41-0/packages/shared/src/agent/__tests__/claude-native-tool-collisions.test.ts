/**
 * P2.512 — our session tools that share a name with a Claude built-in, and why
 * exactly two of them are subtracted rather than six or none.
 *
 * ## The instrument, reused rather than reinvented (P6.52)
 *
 * The runtime's own tool surface is read from the installed
 * `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` — the `ToolInputSchemas`
 * union, whose members are the CLI's tool input schemas. Controlled in both
 * directions below, because a name list that silently became empty would make
 * every collision claim in this file read as "no collisions".
 *
 * ## What the row assumed, and what was measured
 *
 * The row said six session tools are advertised to the model twice right now.
 * Fourteen of our 56 tools do share a name with a built-in and seven of those
 * are projected onto claude, so the collision arithmetic held — but "advertised
 * twice" did not. Read out of the vendored native binary:
 *
 * | projected name | built-in on the surface? | why |
 * | -------------- | ------------------------ | --- |
 * | `Monitor`         | yes | subtracted since T3 |
 * | `CronCreate`      | no  | `isEnabled(){return tQ()}`; `tQ()` reads `CLAUDE_CODE_DISABLE_CRON`, which we force to `1` |
 * | `CronDelete`      | no  | same gate |
 * | `CronList`        | no  | same gate |
 * | `TodoWrite`       | no  | `isEnabled(){return!f6()&&pJ()}`; `f6()` reads `CLAUDE_CODE_ENABLE_TASKS`, which we never set — see the P3.338 correction below |
 * | `ReportFindings`  | yes | left on purpose — the built-in is a documented superset of ours |
 * | `ScheduleWakeup`  | yes | **subtracted here** — no `isEnabled` at all, and its call is a silent no-op |
 *
 * So the live duplicate count was two, not six, and only one of the two was a
 * defect. The three absences are not luck: each depends on an environment
 * decision made somewhere else in this repo, and the tests below PIN THAT
 * COUPLING so that lifting one of those decisions fails here by name instead of
 * quietly re-arming a duplicate. `claude-agent.ts:232` already contemplates
 * `CLAUDE_CODE_DISABLE_CRON` being lifted one day; this is the tripwire for it.
 *
 * ## P3.338 — the `TodoWrite` row above was quoted from a version we no longer
 * ## ship, and the half-sight it shares with `runtime-switch-costs.ts` matters
 *
 * The row used to read `isEnabled(){return !JH() && !Loe()}` and explain only
 * the first term. Two things were wrong with it at `claudeCodeVersion 2.1.233`
 * (`d4948e99b`): the minified names moved (`JH` -> `f6`, `Loe` -> `pJ`) — which
 * is expected and is why AGENTS.md prefers a quoted sentence to an identifier —
 * and the SIGN of the second term inverted. It is `pJ()`, not `!Loe()`.
 *
 * The verdict survives, and it is worth saying WHY rather than letting it look
 * lucky: `f6()` is `if(V.CLAUDE_CODE_ENABLE_TASKS===!1)return!1;return!0`, and
 * nothing in this fork sets that name, so `f6()` is `true`, `!f6()` is `false`,
 * and `TodoWrite` is off whatever `pJ()` answers.
 *
 * **`pJ()` is the part this file's arithmetic did not cover, and it is now
 * DECIDED.** Its four siblings — `TaskCreate`, `TaskGet`, `TaskUpdate`,
 * `TaskList` — carry `isEnabled(){return Eee()}` where
 * `Eee(){return f6()&&pJ()}`, so on a model `pJ()` refuses, all four leave the
 * surface too. That was exactly the claim `runtime-switch-costs.ts` refused a
 * cost row on, and it refused it citing a `.d.ts` union member — a DECLARATION,
 * which cannot express an `isEnabled` predicate. **That half-sight is the part
 * worth carrying forward whichever way the decision went:** a union member says
 * the tool EXISTS, never that this session gets it, so a surface claim needs the
 * shipped binary or the page, never the typings.
 *
 * Owner decision 2026-09-05 (sitting §2.1), option A: opt in, so the four tools
 * stay and the switch cost stays zero at the stated context price. The ROUTE
 * then moved: the 2026-09-05 sitting took the launch option because it was said
 * to cost no deployment change, `4ed0f83a3` measured that the env variable
 * costs none either AND opts in without auto-approving, and the owner switched
 * to `CLAUDE_CODE_ENABLE_TODO_TOOLS` on 2026-09-07 (P6.724).
 * `CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR` in `options.ts` carries the route and its
 * reasons; the block at the bottom of this file pins the four inputs the
 * decision turned on, so neither the threshold list nor the opt-ins can move
 * without someone re-reading them, and it pins WHICH opt-in we take.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CLAUDE_SESSION_DISALLOWED_TOOLS } from '../claude-agent.ts';
import {
  buildClaudeSubprocessEnv,
  CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR,
  CLAUDE_TODO_TOOLS_OPT_IN_RESTORED_TOOLS,
  CLAUDE_TODO_TOOLS_OPT_IN_VALUE,
  getDefaultOptions,
} from '../options.ts';
import { SESSION_TOOL_DEFS } from '@nessy-agent/session-tools-core';

/**
 * The built-in tool names, parsed out of the installed SDK typings. The union
 * members are `<Name>Input`, so the suffix is what identifies a member and is
 * stripped to give the tool name.
 */
function claudeNativeToolNames(): Set<string> {
  const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  const source = readFileSync(`${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk-tools.d.ts`, 'utf8');
  const union = source.match(/export type ToolInputSchemas =([\s\S]*?);\n/);
  if (!union) throw new Error('Could not find ToolInputSchemas in the installed sdk-tools.d.ts');
  return new Set(
    union[1]!
      .split('|')
      .map(member => member.trim())
      .filter(member => member.endsWith('Input'))
      .map(member => member.slice(0, -'Input'.length)),
  );
}

/** Our tools that are pi-only, so their namesake can never collide on claude. */
const OUR_PI_ONLY = SESSION_TOOL_DEFS.filter(def => def.visibility === 'pi-only').map(def => def.name);
/** Our tools that ARE projected onto a claude session. */
const OUR_PROJECTED = SESSION_TOOL_DEFS.filter(def => def.visibility !== 'pi-only').map(def => def.name);

describe('P2.512: the instrument reads the runtime surface, controlled both ways', () => {
  const native = claudeNativeToolNames();

  it('POSITIVE CONTROL — the runtime\'s own tools are present', () => {
    // Without this a parse that silently produced an empty set would make every
    // "no collision" verdict below vacuously true.
    expect(native.size).toBeGreaterThan(40);
    for (const name of ['Bash', 'Glob', 'Grep', 'WebFetch', 'TodoWrite', 'ScheduleWakeup']) {
      expect(native.has(name)).toBe(true);
    }
  });

  it('NEGATIVE CONTROL — tools that are only ours score zero', () => {
    // The other half of P6.52's control: this proves the file is the runtime's
    // surface and not a mixture of both sides.
    for (const name of ['CallLlm', 'SpawnSession', 'Goal']) {
      expect(native.has(name)).toBe(false);
    }
  });
});

describe('P2.512: the collision set, derived from both sides', () => {
  const native = claudeNativeToolNames();

  it('the projected overlap is exactly the seven names the decisions below cover', () => {
    // An eighth projected collision must be DECIDED, not inherited, so it lands
    // here first.
    expect(OUR_PROJECTED.filter(name => native.has(name)).sort()).toEqual([
      'CronCreate', 'CronDelete', 'CronList', 'Monitor', 'ReportFindings', 'ScheduleWakeup', 'TodoWrite',
    ]);
  });

  it('the pi-only overlap collides with nothing, because it is never projected', () => {
    const piOnlyCollisions = OUR_PI_ONLY.filter(name => native.has(name));
    expect(piOnlyCollisions.length).toBeGreaterThan(0);
    // Not one of them may be subtracted: the ban names the BUILT-IN, and these
    // names have no claude projection to protect.
    for (const name of piOnlyCollisions) expect(CLAUDE_SESSION_DISALLOWED_TOOLS).not.toContain(name);
  });
});

describe('P2.512: two subtractions, and each of the five non-subtractions has a reason', () => {
  it('subtracts the two built-ins that are on the surface and worse than ours', () => {
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS).toContain('Monitor');
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS).toContain('ScheduleWakeup');
  });

  it('leaves ReportFindings, whose built-in is a documented superset of ours', () => {
    // Deliberate, and the one the row predicted: the built-in carries the same
    // three `outcome` states ours exists to add, plus `level`, `short_summary`
    // and a severity-ordered cap. Subtracting the better implementation to make
    // the list symmetrical is the failure mode this row warns about.
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS).not.toContain('ReportFindings');
    const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const source = readFileSync(`${sdkEntry.slice(0, sdkEntry.lastIndexOf('/'))}/sdk-tools.d.ts`, 'utf8');
    const schema = source.slice(source.indexOf('export interface ReportFindingsInput'));
    const body = schema.slice(0, schema.indexOf('\nexport '));
    for (const field of ['outcome?:', 'level?:', 'short_summary?:']) expect(body).toContain(field);
  });

  it('COUPLING — the three cron built-ins stay off the list only while the env removes them', () => {
    // `CLAUDE_CODE_DISABLE_CRON=1` is what makes them absent, and
    // `claude-agent.ts` already contemplates that suppression being lifted. If
    // it ever is, three duplicates return and this fails by name.
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_DISABLE_CRON).toBe('1');
    for (const name of ['CronCreate', 'CronDelete', 'CronList']) {
      expect(CLAUDE_SESSION_DISALLOWED_TOOLS).not.toContain(name);
    }
  });

  it('COUPLING — TodoWrite stays off the list only while we never enable the built-in checklist', () => {
    // The built-in is gated on `CLAUDE_CODE_ENABLE_TASKS`; setting it to `0`
    // turns the native checklist back on beside ours, and only ours reaches the
    // host's todo surface.
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_ENABLE_TASKS).toBeUndefined();
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS).not.toContain('TodoWrite');
  });

  it('never names a session tool, only built-ins', () => {
    // The ban matches a plain name to the BUILT-IN; a prefixed entry would
    // remove the projection this row exists to protect.
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS.filter(name => name.startsWith('mcp__'))).toEqual([]);
    expect(CLAUDE_SESSION_DISALLOWED_TOOLS).not.toContain('mcp__session__ScheduleWakeup');
  });
});

// ============================================================
// P3.338 — the model gate on TaskCreate/Get/Update/List and TodoWrite
// ============================================================

/**
 * The five tools the SHIPPED binary withholds by model, and the four inputs an
 * owner decision about them turns on.
 *
 * ## What is pinned, and what is deliberately NOT
 *
 * The gate reads, out of `claude-agent-sdk-darwin-arm64/claude` — transcribed at
 * `2.1.233` on 2026-09-04 and re-read at `2.1.247` after the P7.1 lift, where
 * the SHAPE is unchanged and every identifier moved. Spelled by ROLE, so the
 * transcription survives the next bump; find it again by the
 * `CLAUDE_CODE_ENABLE_TODO_TOOLS===!0` line inside it:
 *
 * ```js
 * function <todoGate>(){if(<isBackgroundJob>()||<launchOptIn>())return!0;let e=<currentModelId>();
 *   if(e===void 0||<belowThreshold>(e))return!0;
 *   if(V.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0)return!0;
 *   return <flag>("tengu_rosy_wren",!1)===!0}
 * function <taskGate>(){return <tasksEnv>()&&<todoGate>()}
 * function <belowThreshold>(e){return!<compare>(e,<thresholds>)}
 * function <compare>(e,t){let r=/^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(e), … }
 * <thresholds>=[["opus",[4,8]],["sonnet",[5]],["fable",[5]],["mythos",[5]]],
 * <taskToolList>=[TodoWrite, TaskCreate, TaskGet, TaskUpdate, TaskList]
 * ```
 *
 * The minified IDENTIFIERS are not asserted, and since P7.1 they are not even
 * written down. They are the equivalent of a line number — a bump reassigns them
 * and a pin on one would fail for a reason nobody needs to act on; the citation
 * gate proved that by going red on exactly this block. What IS asserted is the DATA, which a minifier cannot
 * rename: the threshold list, the env name, the statsig gate name, and the
 * launch-option name behind the fourth opt-in. Those are the four inputs the
 * decision turns on, and each of them moving is something a person must read.
 *
 * ## 2.1.274 INVERTED the gate (F1.1213) — the transcription above is ≤ 2.1.267
 *
 * Two of the four inputs moved at the 0.3.274 lift, and this probe is what saw
 * it. Re-read out of the vendored 2.1.274 by the same anchor:
 *
 * ```js
 * <allowlist>=new Set(["claude-3-opus","claude-3-sonnet","claude-3-haiku","claude-3-5-sonnet",
 *   "claude-3-5-haiku","claude-3-7-sonnet","claude-opus-4-0","claude-opus-4-1","claude-opus-4-5",
 *   "claude-opus-4-6","claude-opus-4-7","claude-sonnet-4-0","claude-sonnet-4-5","claude-sonnet-4-6",
 *   "claude-haiku-4-5"]), <taskToolList>=[…five…];
 * function <todoGate>(){if(<isBackgroundJob>()||<launchOptIn>())return!0;let e=<canonicalModelId>();
 *   if(e===void 0||e.includes("application-inference-profile")||<allowlist>.has(e))return!0;
 *   return V.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0}
 * ```
 *
 * The tools are now OFFERED only on an allowlist of older models and withheld
 * everywhere else, instead of withheld at-or-above a per-family threshold; the
 * binary's own changelog line says the same ("offered only on Claude 3.x, Opus
 * 4.0–4.7, Sonnet 4.0–4.6, Haiku 4.5; set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`
 * elsewhere"). The remote `tengu_rosy_wren` gate is GONE (0 occurrences), and
 * the threshold list survives only for an unrelated gate. The env opt-in we take
 * (P6.724) and the launch option are unchanged, so for our sessions the tools
 * are restored exactly as before — what changed is that the opt-in now matters
 * for every model outside the allowlist (e.g. `claude-haiku-5`), not only the
 * listed families. What a GATEWAY id gets without the opt-in depends on the
 * canonicaliser (`undefined` keeps the tools) and is not measured here.
 *
 * ## The fourth opt-in, which the sweep row had not found — and which we now TAKE
 *
 * The launch-option opt-in is `…host.launchOptions.todoToolsOptIn()`, and the
 * CLI sets it from its own argv — `<set>(<taskToolList>.some(p))` inside the
 * argv reader that takes `{allowedToolsCli, …}` — where `p` tests whether any of
 * the five is NAMED in `--allowedTools` or in an explicit non-preset tools list.
 * (Spelled by ROLE and not by minified name: the 0.3.233 -> 0.3.247 bump
 * reassigned every one of them, which `scripts/check-minified-citations.ts`
 * caught. The surviving anchors are the option name above and
 * `todoToolsOptIn` itself.) We pass `{ type:'preset', preset:'claude_code' }`
 * and used to pass no `allowedTools`, so it was false. It is the route the owner
 * chose (2026-09-05, sitting §2.1, option A) precisely because it costs no
 * environment variable and therefore no deployment change, and
 * `getDefaultOptions` now returns the four Task names in `allowedTools`.
 * `tools-reference.md#task-tool-availability` names the same route for the SDK:
 * *"In the Agent SDK, the `allowedTools` and `tools` options work the same way
 * as the two flags."*
 *
 * ## Why the model arithmetic is reimplemented here rather than probed
 *
 * The binary's own gate is a componentwise comparison of a parsed
 * `claude-<family>-<digits>` id against the threshold list. Reimplementing it makes the CONSEQUENCE for our
 * own `DEFAULT_MODEL` assertable offline and readable by whoever takes the
 * decision — which the binary probe alone cannot give. Both are here, so a
 * threshold list that moves fails the probe and a default model that moves
 * fails the arithmetic.
 */
describe('P3.338 — the Task/Todo model gate in the shipped binary', () => {
  /**
   * The five names `tools-reference.md#task-tool-availability` lists, verbatim:
   * *"the following tools aren't available on Opus 4.8, Sonnet 5, Fable 5,
   * Mythos 5, or later versions of those families unless you opt in:
   * `TodoWrite`, `TaskCreate`, `TaskGet`, `TaskUpdate`, and `TaskList`."* The
   * binary's own opt-in predicate is `<taskToolList>.some(p)` over this same set, so it is
   * written out once here and both assertions below derive from it.
   */
  const TASK_MODEL_GATED_TOOLS = ['TodoWrite', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList'] as const;

  /** The 2.1.274 gate's allowlist, as the binary spells it (F1.1213). */
  const ALLOWLIST_LITERAL = 'new Set(["claude-3-opus","claude-3-sonnet","claude-3-haiku","claude-3-5-sonnet","claude-3-5-haiku","claude-3-7-sonnet","claude-opus-4-0","claude-opus-4-1","claude-opus-4-5","claude-opus-4-6","claude-opus-4-7","claude-sonnet-4-0","claude-sonnet-4-5","claude-sonnet-4-6","claude-haiku-4-5"])';

  const NATIVE_BINARY = (() => {
    const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const nodeModules = sdkEntry.slice(0, sdkEntry.lastIndexOf('/@anthropic-ai/'));
    return `${nodeModules}/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`;
  })();

  /** One `grep -a -q -F` pass. `-q` exits at the first hit, so a PRESENT marker is cheap. */
  const inBinary = (marker: string): boolean =>
    Bun.spawnSync(['grep', '-a', '-q', '-F', '-e', marker, NATIVE_BINARY]).exitCode === 0;

  const haveBinary = (): boolean => {
    try {
      return Bun.file(NATIVE_BINARY).size > 0;
    } catch {
      return false;
    }
  };

  // ~9 s of `grep` over a 300 MB binary. Bun's 5 s default would fail this for
  // the wrong reason; the budget is set against the measured floor, not zero.
  it('carries the threshold list, both opt-in names and the statsig gate', () => {
    if (!haveBinary()) return; // darwin-arm64 artefact; absent on other hosts.

    // The inputs an owner decision turns on. Data literals, not identifiers.
    // F1.1213 (2.1.274): the allowlist replaced the threshold list as the gate's
    // data, and the remote gate left the binary.
    expect(inBinary(ALLOWLIST_LITERAL)).toBe(true);
    expect(inBinary('.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0}')).toBe(true);
    expect(inBinary('tengu_rosy_wren')).toBe(false);
    expect(inBinary('todoToolsOptIn')).toBe(true);

    // Zero control on the identical instrument: without it, a `grep` that
    // matched everything (or an `exitCode` read the wrong way round) would make
    // all four assertions above pass for no reason.
    expect(inBinary('zzNotARealMarkerP3338')).toBe(false);
  }, 60_000);

  /**
   * The binary's gate at 2.1.274, reimplemented over a CANONICAL id (F1.1213):
   * `true` means outside the allowlist, which is the case where the five tools
   * are WITHHELD absent an opt-in. Through 2.1.267 this was an at-or-above
   * comparison against `[["opus",[4,8]],["sonnet",[5]],["fable",[5]],["mythos",[5]]]`.
   */
  const ALLOWLIST = [
    'claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku', 'claude-3-5-sonnet', 'claude-3-5-haiku',
    'claude-3-7-sonnet', 'claude-opus-4-0', 'claude-opus-4-1', 'claude-opus-4-5', 'claude-opus-4-6',
    'claude-opus-4-7', 'claude-sonnet-4-0', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-haiku-4-5',
  ] as const;
  function withheldWithoutOptIn(canonicalId: string): boolean {
    if (canonicalId.includes('application-inference-profile')) return false;
    return !(ALLOWLIST as readonly string[]).includes(canonicalId);
  }

  it('our own DEFAULT_MODEL is outside the allowlist, so the withdrawal is deterministic', async () => {
    const { DEFAULT_MODEL } = await import('../../config/models.ts');
    expect(DEFAULT_MODEL).toBe('claude-opus-4-8');
    expect(withheldWithoutOptIn(DEFAULT_MODEL)).toBe(true);
  });

  it('names honestly which canonical ids the gate does and does not reach', () => {
    // Outside the allowlist: withheld without an opt-in.
    expect(withheldWithoutOptIn('claude-opus-4-8')).toBe(true);
    expect(withheldWithoutOptIn('claude-opus-5')).toBe(true);
    expect(withheldWithoutOptIn('claude-sonnet-5')).toBe(true);
    // F1.1213: a family the old threshold list did not name is now withheld too.
    expect(withheldWithoutOptIn('claude-haiku-5')).toBe(true);
    // On the allowlist: unaffected. `claude-sonnet-4-6` is the one this repo is
    // most likely to run beside the default, so it is named rather than covered
    // by a generalisation.
    expect(withheldWithoutOptIn('claude-opus-4-7')).toBe(false);
    expect(withheldWithoutOptIn('claude-sonnet-4-6')).toBe(false);
    // The inference-profile carve-out the binary keeps.
    expect(withheldWithoutOptIn('arn:aws:bedrock:eu-west-1:000000000000:application-inference-profile/x')).toBe(false);
  });

  /**
   * P3.338, DECIDED, and P6.724 moved the ROUTE. This test used to assert "we
   * take none of the four opt-ins", then "we take the launch option"; the owner
   * switched to the env variable on 2026-09-07 once its second price was
   * measured. What is pinned is WHICH ONE we take and which three we still do
   * not — each refusal asserted rather than left implied, because moving to a
   * different one is a decision, not a refactor.
   */
  it('takes the env opt-in and NONE of the other three', () => {
    const shared = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    const childEnv = buildClaudeSubprocessEnv();
    // TAKEN — (2) the env opt-in. Asserted on the VALUE the child receives, not
    // on the source text: the earlier `source.includes(name)` form went RED the
    // moment `options.ts` explained in prose why the owner had NOT chosen this
    // route, and it would go GREEN now for the same bad reason — a text read
    // cannot tell a mention from a use.
    expect(childEnv[CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR]).toBe(CLAUDE_TODO_TOOLS_OPT_IN_VALUE);
    expect(CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR).toBe('CLAUDE_CODE_ENABLE_TODO_TOOLS');
    // Negative control on the identical instrument: the builder does not simply
    // answer every name asked of it.
    expect(childEnv.CLAUDE_CODE_ENABLE_TODO_TOOLS_NOT_A_REAL_NAME).toBeUndefined();
    // NOT taken — (1) the allow-list route, WITHDRAWN by P6.724. A bare entry in
    // `allowedTools` is an auto-approval: it shadows `canUseTool` ahead of our
    // own gate and makes the SDK emit `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`, which
    // P6.207 surfaces as a per-session degradation notice. Withdrawing it is
    // what buys the notice its meaning back, so the absence is the control that
    // the notice cannot fire from this route.
    expect(getDefaultOptions().allowedTools).toBeUndefined();
    // NOT taken — (3) the remote gate: `tengu_rosy_wren` could not answer true on the
    // gateway path, whose adapter env forces the nonessential-traffic switch; at
    // 2.1.274 the gate is gone from the binary altogether (F1.1213, F1.1220).
    expect(shared.includes('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBe(true);
    // NOT taken — (4) the non-preset tools list: we still send a preset, so the
    // predicate's `baseTools` half stays false and the env variable above is the
    // whole of the opt-in.
    expect(shared.includes("preset: 'claude_code'")).toBe(true);
    // One multi-thousand-line source read. Measured at 10.9 s on a loaded box
    // against bun's 5 s default, which failed this for the wrong reason once;
    // the budget is set against that floor rather than at zero.
  }, 60_000);

  it('never overwrites an opt-in answer the operator already gave', () => {
    // The whole reason `applyTodoToolsOptIn` is a default and not an assignment:
    // an operator who exported `0` turned these tools OFF, and the page's own
    // route is that export. Driven through `envOverrides`, which lands in the
    // same merged object an inherited value lands in — and the two spellings
    // agree here, measured: this name is NOT one of Bun's nine pre-created
    // `process.env` slots, so a spread of `process.env` is a complete reading
    // of it.
    const off = buildClaudeSubprocessEnv({ [CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR]: '0' });
    expect(off[CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR]).toBe('0');
    // The control on the same call shape: without an answer, the default lands.
    expect(buildClaudeSubprocessEnv()[CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR])
      .toBe(CLAUDE_TODO_TOOLS_OPT_IN_VALUE);
  });

  it('does NOT count TodoWrite among what the switch restores', () => {
    // `TodoWrite`'s `isEnabled` is the inverse of the four on the
    // `CLAUDE_CODE_ENABLE_TASKS` half, which nothing here sets, so it stays off
    // whatever this switch says and listing it would promise a tool that never
    // reaches the surface. The page agrees: "TodoWrite ... Disabled by default
    // in favor of TaskCreate, TaskGet, TaskList, and TaskUpdate."
    expect(CLAUDE_TODO_TOOLS_OPT_IN_RESTORED_TOOLS).not.toContain('TodoWrite');
    // NEGATIVE CONTROL on the same list: the four named are exactly the
    // model-gated Task tools, so a fifth name creeping in fails here.
    expect([...CLAUDE_TODO_TOOLS_OPT_IN_RESTORED_TOOLS].sort())
      .toEqual([...TASK_MODEL_GATED_TOOLS].filter(name => name !== 'TodoWrite').sort());
    // And every one of them is a real built-in on the installed SDK — the set
    // is what the child's tool list gains, so a typo would silently describe a
    // tool that does not exist.
    const native = claudeNativeToolNames();
    for (const name of CLAUDE_TODO_TOOLS_OPT_IN_RESTORED_TOOLS) expect(native.has(name)).toBe(true);
  });
});
