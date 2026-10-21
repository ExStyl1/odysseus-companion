/**
 * **C3.115 (QH9, owner answer B) — P6.125's measurement: is the SDK's own
 * dynamic-workflow engine reachable in a gateway session, or entitlement-gated?**
 *
 * Measured 2026-09-11 on the vendored `0.3.247` / `2.1.247` (both self-reports
 * agree; the binary's own `--version` says `2.1.247 (Claude Code)`). The rig is
 * three scripts, written for this row and kept out of the tree because they
 * spawn the 233 MB native binary and, in the live half, spend real gateway
 * calls. Their arms are reproduced below so a later reader can re-drive them.
 *
 * **Answer: REACHABLE, not entitlement-gated — and already reachable before
 * this round, which refutes the row's own premise.**
 *
 * ## Arm table — the init roster's `tools` array is the instrument
 *
 * `sdk.d.ts`'s `SDKSystemMessage` carries `tools: string[]`, and the vendored
 * binary names the tool `Workflow` (`WORKFLOW_TOOL_NAME:()=>rd…var rd="Workflow"`).
 * Every arm ran with the gateway path's own environment — a custom
 * `ANTHROPIC_BASE_URL`, an API key, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
 * (what `startLocalAdapterRuntime` writes) — and this host's own
 * `settingSources: ['user','project','local']`.
 *
 * | arm | what was in force | `Workflow` on the roster |
 * | --- | --- | --- |
 * | A | nothing (HEAD's default: no workflow key travels) | **yes** |
 * | B | flag `enableWorkflows: true` | yes |
 * | C | flag `enableWorkflows: false` (HEAD's off projection) | no |
 * | D | flag `disableWorkflows: true` | no |
 * | E | flag `enableWorkflows: true` **and** `disableWorkflows: true` | no |
 * | F | flag `enableWorkflows: true` + guideline + keyword off | yes |
 * | G | USER-tier `disableWorkflows: true` + flag `enableWorkflows: true` | no |
 * | H | USER-tier `enableWorkflows: false` + flag `enableWorkflows: true` | **yes** |
 * | K | USER-tier `enableWorkflows: false`, no flag key (today) | no |
 * | J | PROJECT-tier `disableWorkflows: true` + flag `enableWorkflows: true` | no |
 * | I | `CLAUDE_CODE_DISABLE_WORKFLOWS=1` + flag `enableWorkflows: true` | no |
 * | L | USER-tier `disableWorkflows: true`, no flag key | no |
 *
 * Control on every arm: `Task` present, proving the read works; arm A and arm B
 * produced **byte-identical rosters** (24 names, empty set difference in both
 * directions), which is the refutation.
 *
 * ## Why A is already `yes`, read out of the binary rather than guessed
 *
 * The whole decision is five functions, quoted from the vendored `2.1.247`
 * (the minifier's names are its own and a bump reassigns them — P3.309 — so
 * read the branches by what they contain):
 *
 *     function G(){return E.CLAUDE_CODE_DISABLE_WORKFLOWS||w()?.settings.disableWorkflows===!0}
 *     function q(){if(G())return!1;if(!Q())return!1;let{available:e,defaultOn:t}=Z();
 *       if(!e)return!1;return w()?.settings.enableWorkflows??t}
 *     function Q(){return Pe("allow_workflows")}
 *     function Ct(){…if(!g("tengu_workflows_enabled",!0))return{available:!1,defaultOn:!1};
 *       return{available:!0,defaultOn:we()!=="pro"}}
 *
 * Three things follow, and the third is the product fact:
 *
 * 1. **`disableWorkflows` is checked FIRST and wins everywhere** — over the
 *    permissive key, at every settings tier, and from the environment. Arms
 *    E/G/J/I/L. So the organisation's off switch is the vendor's own and needs
 *    nothing from this host.
 * 2. **`allow_workflows` is an org-policy key, and it is NOT in the set that
 *    denies when no policy table is present** (the binary's `isPolicyAllowed`
 *    returns true for a key outside that set). A gateway session has no policy
 *    table, so this gate is open rather than closed — which is what "not
 *    entitlement-gated" means here.
 * 3. **UNSET is not OFF; unset is `defaultOn`, and `defaultOn` is
 *    `we()!=="pro"`** — the OAuth subscription type, which is `null` on any
 *    session that is not signed in to Anthropic. So the answer this fork's
 *    users get today is *on* for the gateway card and *off* for a direct
 *    Anthropic **Pro** subscriber, while Pi's engine is on for everyone. That
 *    plan-dependent divergence — not an absent engine — is what C3.116 closes
 *    by sending the host's own answer definitely.
 *
 * ## The live half: a real gateway session RAN one
 *
 * Same rig, upstream replaced by the shipped card's own path —
 * `startAdapter({})` → the Nestor gateway, credentials from this app's own dp
 * module, model resolved through the `coder` ALIAS (`tgpt/deepseek-v4-flash-0731`
 * on the day; never pin the id, W12-f). Two runs:
 *
 * - `Workflow` on the init roster; the gateway's own model emitted a `Workflow`
 *   tool_use whose `script` was a well-formed workflow (`export const meta`,
 *   `phases`, two `await agent(...)` calls). Control: the same session with
 *   `disableWorkflows: true` had no `Workflow` on the roster and made no call.
 * - With the call ALLOWED, the engine executed: `system/task_started`,
 *   `task_progress "Statements: about-two"` and `"about-three"` — the two agents
 *   the script asked for — then `task_notification "Dynamic workflow … completed"`,
 *   4.5 s to 5.7 s into the turn, with the script written under the session's
 *   own `workflows/scripts/` directory. `result: success`.
 *
 * So the engine is reachable AND drivable by the gateway's own model. The one
 * cosmetic wrinkle the run surfaced is unrelated: the child logs
 * `[claude-code:unrecognized_model]` for the gateway's model id.
 *
 * ## What is pinned here, and what is not
 *
 * The native binary is deliberately NOT read by this suite — it is 233 MB, and
 * the house rule in `backend/claude/__tests__/binary-evidence.test.ts` is that a
 * unit test reads `sdk.d.ts` and `sdk.mjs` only. What those two CAN carry is the
 * contract the measurement rests on: the four declarations, the sentence that
 * makes "unset" a non-answer, and the restrictive managed-settings filter's own
 * entries for the two booleans. A vendor bump that changes any of them turns
 * this red, which is the signal to re-drive the arms above rather than to trust
 * a dated table.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

/** The vendored declaration file; small enough for a unit test to read whole. */
function sdkArtefact(file: 'sdk.d.ts' | 'sdk.mjs'): string {
  const entry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  const path = `${entry.slice(0, entry.lastIndexOf('/'))}/${file}`;
  if (!existsSync(path)) throw new Error(`vendored ${file} missing at ${path}`);
  return readFileSync(path, 'utf8');
}

describe('C3.115 — the workflow engine the SDK ships, and the switches that govern it', () => {
  test('all four keys are declared on `Settings`, so nothing here is invented', () => {
    const dts = sdkArtefact('sdk.d.ts');
    expect(dts.length).toBeGreaterThan(100_000);
    for (const declaration of [
      'enableWorkflows?: boolean;',
      'disableWorkflows?: boolean;',
      "workflowSizeGuideline?: 'unrestricted' | 'small' | 'medium' | 'large';",
      'workflowKeywordTriggerEnabled?: boolean;',
    ]) {
      expect(dts).toContain(declaration);
    }
    // The positive control for the read: a neighbour on the same interface.
    expect(dts).toContain('disableRemoteControl?: boolean;');
  });

  /**
   * The sentence is the whole reason an UNSET key is not an answer, and it is
   * the vendor's own words. Without it a reader would take "we send nothing" for
   * "the engine is off", which is what the plan row assumed and the arms refute.
   */
  test('the vendor documents the unset state as PLAN-dependent, not as off', () => {
    expect(sdkArtefact('sdk.d.ts')).toContain(
      'Enable or disable the Workflows feature for this user. Unset = default by plan once the feature is available.',
    );
  });

  /**
   * `disableWorkflows` is documented as reachable from the environment too, and
   * arm I drove that env var to a measured `no`. Pinned so a rename is loud.
   */
  test('the hard off switch names its own environment variable', () => {
    expect(sdkArtefact('sdk.d.ts')).toContain(
      'Disable the Workflows feature (also via CLAUDE_CODE_DISABLE_WORKFLOWS).',
    );
  });

  /**
   * **The org-wide switch is the vendor's, and this is the proof it needs
   * nothing from us.** The restrictive managed-settings filter — the table after
   * `parentSettingsBehavior==="merge"` in the vendored bundle — carries BOTH
   * booleans, each with the pole that makes an organisation's answer win:
   * `disableWorkflows` restricts at `true`, `enableWorkflows` at `false`. That
   * is the opposite of `switchModelsOnFlag`, which the same filter does NOT
   * copy and which therefore has to ride `Options.settings` (see
   * `claude-auto-mode-policy.ts`). Read out of the bundle rather than restated,
   * so the day the SDK drops either entry this goes red.
   *
   * The negative control was `feedbackDrafts` when this test was first written,
   * and it FAILED — `{path:["feedbackDrafts"],restrictive:"off"}` really is in
   * this table at `0.3.247`. That is NOT a refutation of
   * `claude-auto-mode-policy.ts`'s `CLAUDE_FEEDBACK_DRAFTS_SETTING` docblock,
   * and C3.257 measured why (2026-09-12, `04c578187`): the bundle carries TWO
   * restrictive mechanisms. THIS table is the ADMIN-TIER merge's — it folds
   * remote + MDM + file into one admin document by taking each key's most
   * restrictive value, and a sandbox-only extractor reads its `sandbox` rows.
   * The mechanism that docblock is about is the COPY LIST, the two-argument
   * function whose first line is `if(e.allowManagedHooksOnly===!0)`, which is
   * what the call site applies to our `Options.managedSettings` slice — and
   * `feedbackDrafts` is not in it, read end to end in `sdk.mjs` at `0.3.247`. A
   * key can sit in one and not the other, so a control drawn from this table
   * cannot decide a claim about that filter; pick the control from the same
   * mechanism.
   */
  test('the restrictive managed filter carries both booleans, each at its own pole', () => {
    const bundle = sdkArtefact('sdk.mjs');
    expect(bundle.length).toBeGreaterThan(1_000_000);
    expect(bundle).toContain('{path:["disableWorkflows"],restrictive:!0}');
    expect(bundle).toContain('{path:["enableWorkflows"],restrictive:!1}');
    // Positive control on the same table, and the negative one that makes the
    // two lines above a measurement: a key the filter demonstrably does not copy.
    expect(bundle).toContain('{path:["disableRemoteControl"],restrictive:!0}');
    expect(bundle).not.toContain('{path:["switchModelsOnFlag"]');
  });

  /**
   * The one HOST-side condition the measured roster depends on. `Workflow` is
   * not on this fork's disallow list, and a later lane adding it would silently
   * undo C3.116 — the arms above would still pass, because they drive the SDK
   * and not this constant.
   */
  test('this host does not disallow the `Workflow` tool', () => {
    const source = readFileSync(
      new URL('../claude-agent.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('CLAUDE_SESSION_DISALLOWED_TOOLS: readonly string[] = Object.freeze([');
    expect(start, 'the disallowed-tools literal moved or was renamed').toBeGreaterThan(-1);
    const literal = source.slice(start, source.indexOf(']);', start));
    const names = [...literal.matchAll(/'([A-Za-z_]+)'/g)].map(match => match[1]!);
    // The control: the list is non-empty and holds a name we know is in it, so
    // a parse that silently returned nothing cannot pass this.
    expect(names).toContain('ExitPlanMode');
    expect(names).not.toContain('Workflow');
  });
});
