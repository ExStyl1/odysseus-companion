/**
 * P2.313 — the documented operator CEILINGS, and which runtime honours them.
 *
 * `env-vars.md#variables` documents a set of variables an administrator sets to
 * bound what a session may do. Three of them bound the Bash tool:
 *
 * - "`BASH_DEFAULT_TIMEOUT_MS` | Default timeout for long-running bash commands
 *   (default: 120000, or 2 minutes)"
 * - "`BASH_MAX_TIMEOUT_MS` | Maximum timeout the model can set for long-running
 *   bash commands (default: 600000, or 10 minutes). The effective ceiling is the
 *   larger of this and `BASH_DEFAULT_TIMEOUT_MS`"
 * - "`BASH_MAX_OUTPUT_LENGTH` | Maximum number of characters of bash output that
 *   Claude Code reads back into a command's result (default: 30000; maximum:
 *   150000)."
 *
 * On claude-runtime these work, and they work for exactly one reason: this
 * builder spreads `process.env`, so the vendored native binary — which carries
 * all three names (`/usr/bin/grep -a -o` over
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, Claude Code 2.1.223:
 * 5, 5 and 10 occurrences; a fabricated control name scores 0) — reads them
 * itself. Nothing in this repository reads any of the three (`git grep -a -F`
 * over `packages apps` → 0 files each, with `CLAUDE_CODE_MAX_RETRIES` as the
 * positive control at 4 files).
 *
 * That makes the pass-through a load-bearing contract rather than an incidental
 * spread, and it had no test. The change that would break it is a plausible and
 * well-intentioned one — scrubbing the child environment, which is what
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` and `CLAUDE_CODE_MCP_ALLOWLIST_ENV` exist
 * to opt into on Claude's own side. Such a change must fail here rather than
 * silently unbound every administrator's Bash timeout.
 *
 * WHAT PI DOES WITH THE SAME THREE — corrected 2026-09-03 (P3.271(d)).
 *
 * This block used to say *"Pi honours none of the three"*, resting on *"Nothing
 * in this repository reads any of the three (`git grep -a -F` over `packages
 * apps` → 0 files each, with `CLAUDE_CODE_MAX_RETRIES` as the positive control
 * at 4 files)"*. Both halves were true when written and are false at HEAD. Same
 * instrument, re-run: `BASH_DEFAULT_TIMEOUT_MS` **6** files,
 * `BASH_MAX_TIMEOUT_MS` **5**, `BASH_MAX_OUTPUT_LENGTH` **5**, with the same
 * control at **5** — so even the control had moved, which is the tell that the
 * paragraph was a reading with a date rather than a fact. All three are honoured
 * on Pi:
 *
 * - `BASH_DEFAULT_TIMEOUT_MS` → `resolveBashDefaultTimeoutMs`, applied at the
 *   `bash` port in `pi-agent-server/.../runtime-backed-tools.ts` — the only
 *   layer that still knows the model sent no `timeout` of its own.
 * - `BASH_MAX_TIMEOUT_MS` → `clampSupervisedChildTimeoutMs`, applied HOST-side
 *   beside the allowlist rebuild a subprocess cannot smuggle a field past. It
 *   only ever lowers, and `background` starts are exempt by argument there. The
 *   effective ceiling is the LARGER of it and the default, per the page, so a
 *   maximum set below the default does not bind.
 * - `BASH_MAX_OUTPUT_LENGTH` → `resolveBashReadBackChars` /
 *   `applyBashOutputLimits` on the Pi/host Bash path.
 *
 * The rot is the useful part, and it is why this is no longer prose alone. The
 * claim was about OTHER files, so nothing in this suite could fail when those
 * files changed: five green assertions about the Claude subprocess env sat under
 * a paragraph asserting a Pi behaviour not one of them touched — the
 * documented-claim-versus-assertion split this repo has now paid for three
 * times. All three resolvers take an explicit env record, so the claim costs one
 * test to BIND rather than one paragraph to restate, and that test is the second
 * `describe` below. It is not a duplicate of each resolver's own suite: what it
 * pins is that the CLAUDE-documented spelling reaches Pi at all, which is the
 * sentence this docblock got wrong.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { buildClaudeSubprocessEnv } from '../options.ts';
import { CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS } from '../../config/claude-provider-routing-env.ts';
import {
  clampSupervisedChildTimeoutMs,
  resolveBashDefaultTimeoutMs,
} from '../pi-harness/process-supervisor-port.ts';
import { resolveBashReadBackChars } from '../../config/bash-output-limits.ts';

/** The three the page assigns to the Bash tool, in the page's own spelling. */
const BASH_CEILINGS = [
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_TIMEOUT_MS',
  'BASH_MAX_OUTPUT_LENGTH',
] as const;

/**
 * The wider ceiling set, restricted to names verified PRESENT in the vendored
 * binary — so each row is a knob that really does something on claude-runtime
 * today, not merely a documented one.
 *
 * ## P3.321 — `CLAUDE_CODE_TOOL_MEMORY_LIMIT` CROSSED INTO THE BUNDLE, and this
 * ## docblock went on excluding it against the binary it crossed from
 *
 * The excluded pair used to read: *"both score 0 in that binary (the page dates
 * them v2.1.248 and v2.1.246), so they are inert on BOTH runtimes and are not an
 * asymmetry."* That binary was **2.1.223**; stage 0.3 lifted the bundle to
 * **2.1.233**, and the name arrived in the lift. Counted in the shipped
 * `claude-agent-sdk-darwin-arm64` binary (2026-09-03), with controls in both
 * directions:
 *
 * Re-measured 2026-09-12 on the vendored **2.1.247** (C3.252), and every count
 * now carries its INSTRUMENT because the two answer differently on a minified
 * artefact (C3.294) — the 2026-09-03 column said only "count":
 *
 * | Name | lines (`grep -acF`) | occurrences (`grep -aoF … \| wc -l`) | 2026-09-03 at 2.1.233 |
 * | --- | ---: | ---: | ---: |
 * | `CLAUDE_CODE_TOOL_MEMORY_LIMIT` | **5** | **6** | 3 (0 at 0.3.223) |
 * | `CLAUDE_CODE_RESTRICTED` (negative control, still excluded) | **0** | **0** | 0 |
 * | `BASH_MAX_OUTPUT_LENGTH` (positive control) | 5 | 6 | 10 |
 * | `CLAUDE_CODE_MAX_TURNS` (positive control) | 4 | 5 | 5 |
 *
 * The page moved with it: *"Requires Claude Code v2.1.233 or later"* — at or
 * past our `claudeCodeVersion`, which self-reported `2.1.251` on 2026-09-18 (it
 * was exactly 2.1.233 when this paragraph was written) — with 2.1.246 demoted
 * to a Monitor-only caveat.
 *
 * **AND THE BINARY NARROWS THE CLAIM the count alone would support, which is why
 * the variable is read here rather than inferred.** Exactly ONE of the six
 * occurrences is functional, and that is the half the count cannot tell you: the
 * others are the env-name accessor map, a cgroup-diagnostics string table, two
 * occurrences on one line of an LSP crash-attribution message, and the shipped
 * changelog entry. The functional one still opens the way it did — the minified
 * names moved (`Kt` → `F`, `V` → `x`, and the module-level `CZt` is now a field
 * on a memoised record), so read it by this shape and not by those letters:
 *
 *     (2.1.233) let e=Kt(); if(e!=="linux"&&e!=="wsl"){CZt=null;return}
 *               let t=V.CLAUDE_CODE_TOOL_MEMORY_LIMIT?.trim().toLowerCase();
 *
 *     (2.1.247) let r=F(); if(r!=="linux"&&r!=="wsl"){e.dir=null;return}
 *               let n=x.CLAUDE_CODE_TOOL_MEMORY_LIMIT?.trim().toLowerCase();
 *
 * — the platform is tested BEFORE the variable is read, and the mechanism behind
 * it is a cgroup (`/proc/self/cgroup`). The page says the same thing first:
 * *"On Linux and WSL, set to a size such as `4G` to cap the memory that Bash and
 * PowerShell tool commands can use"*. So on darwin — this fork's desktop, and
 * every rig in this wave — it is still inert, but for a DOCUMENTED PLATFORM
 * REASON rather than because the binary has never heard of it. The old sentence
 * was wrong in its premise and accidentally right in its conclusion, on one
 * platform.
 *
 * It joins the list because the list's contract is *the binary really reads
 * this*, and on a Linux or WSL host it does. The pass-through below is the
 * honouring half; the residue is that the asymmetry it creates there — an
 * operator's memory cap reaching claude's Bash/PowerShell and NEITHER other
 * runtime, since nothing in this tree reads the name (`git grep` finds only
 * prose) — is not announced at a switch. `runtime-switch-costs.ts` is where that
 * belongs and is another lane's file; reported rather than written here.
 *
 * `CLAUDE_CODE_RESTRICTED` stays excluded on its own measurement, unchanged.
 */
const OTHER_CEILINGS = [
  'CLAUDE_CODE_MAX_TURNS',
  'CLAUDE_CODE_TOOL_MEMORY_LIMIT',
  // C3.148 — the companion of the line above, and it arrived after this list was
  // written. `tools-reference.md#memory-limit-on-linux-and-wsl`: "Claude Code can
  // also count other kinds of processes it starts against the same limit. Set
  // `CLAUDE_CODE_TOOL_MEMORY_CGROUP_EXCLUDE` to a comma-separated list of the
  // kinds to exempt from the cap … Requires Claude Code v2.1.246 or later" — and
  // the vendored bundle self-reports `2.1.247` (its `package.json`
  // `claudeCodeVersion` and `claude --version` agree), so it is past that floor.
  // Membership taken from the bundle rather than the page, as AGENTS.md requires:
  // `grep -aoF` over the vendored `claude` answers 3, against 6 for the LIMIT
  // name it companions and 0 for a name that does not exist.
  'CLAUDE_CODE_TOOL_MEMORY_CGROUP_EXCLUDE',
  'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_GLOB_TIMEOUT_SECONDS',
  'CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT',
  'SLASH_COMMAND_TOOL_CHAR_BUDGET',
] as const;

const TOUCHED = [...BASH_CEILINGS, ...OTHER_CEILINGS, ...CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS];
const saved = new Map<string, string | undefined>();
for (const key of TOUCHED) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of TOUCHED) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('P2.313 documented operator ceilings reach the Claude subprocess', () => {
  it('carries the Bash ceiling trio from the host environment', () => {
    process.env.BASH_DEFAULT_TIMEOUT_MS = '30000';
    process.env.BASH_MAX_TIMEOUT_MS = '60000';
    process.env.BASH_MAX_OUTPUT_LENGTH = '40000';

    const env = buildClaudeSubprocessEnv();

    expect(env.BASH_DEFAULT_TIMEOUT_MS).toBe('30000');
    expect(env.BASH_MAX_TIMEOUT_MS).toBe('60000');
    expect(env.BASH_MAX_OUTPUT_LENGTH).toBe('40000');
  });

  it('carries the wider ceiling set the vendored binary actually reads', () => {
    for (const [index, key] of OTHER_CEILINGS.entries()) {
      process.env[key] = String(1000 + index);
    }

    const env = buildClaudeSubprocessEnv();

    for (const [index, key] of OTHER_CEILINGS.entries()) {
      expect(env[key]).toBe(String(1000 + index));
    }
  });

  it('lets a per-session override win over the ambient ceiling', () => {
    process.env.BASH_MAX_TIMEOUT_MS = '60000';

    const env = buildClaudeSubprocessEnv({ BASH_MAX_TIMEOUT_MS: '15000' });

    expect(env.BASH_MAX_TIMEOUT_MS).toBe('15000');
  });

  it('invents no ceiling of its own when the operator set none', () => {
    // The discriminating half: without this, an assertion that a key is
    // "defined" would pass on a builder that hard-coded every ceiling, and the
    // test above would stop measuring pass-through.
    for (const key of BASH_CEILINGS) delete process.env[key];

    const env = buildClaudeSubprocessEnv();

    for (const key of BASH_CEILINGS) expect(env[key]).toBeUndefined();
  });

  it('still strips the cloud-provider routing keys, so this is not a blanket carry', () => {
    // Positive control on the pass-through claim: the same builder that carries
    // a ceiling verbatim removes a routing toggle set in the same environment.
    // If both survived, the first assertion would prove nothing about intent.
    process.env.BASH_MAX_TIMEOUT_MS = '60000';
    for (const key of CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS) process.env[key] = '1';

    const env = buildClaudeSubprocessEnv();

    expect(env.BASH_MAX_TIMEOUT_MS).toBe('60000');
    for (const key of CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS) expect(env[key]).toBeUndefined();
  });
});

describe('the same three ceilings on Pi, so this file cannot mis-state them again', () => {
  // Every resolver here takes an explicit record, so nothing in this describe
  // touches `process.env` and it cannot interact with the suite above.
  it('reads the documented Claude spelling of all three on the Pi path', () => {
    expect(resolveBashDefaultTimeoutMs({ BASH_DEFAULT_TIMEOUT_MS: '45000' })).toBe(45_000);
    // Above the 120000 default on purpose: the page makes the effective ceiling
    // the LARGER of the two, so a maximum under the default would not bind and
    // the assertion would be measuring the default instead.
    expect(clampSupervisedChildTimeoutMs(
      { timeoutMs: 900_000, background: false },
      { BASH_MAX_TIMEOUT_MS: '300000' },
    ).timeoutMs).toBe(300_000);
    expect(resolveBashReadBackChars({ BASH_MAX_OUTPUT_LENGTH: '40000' })).toBe(40_000);
  });

  it('falls back to the documented defaults when the operator set none', () => {
    // The discriminating half, the same shape as the Claude-side control above:
    // without it, an assertion that a value "changed" would still pass on a
    // resolver that ignored its env and hard-coded the number.
    expect(resolveBashDefaultTimeoutMs({})).toBe(120_000);
    expect(clampSupervisedChildTimeoutMs({ timeoutMs: 900_000, background: false }, {}).timeoutMs)
      .toBe(600_000);
    expect(resolveBashReadBackChars({})).toBe(30_000);
  });
});
