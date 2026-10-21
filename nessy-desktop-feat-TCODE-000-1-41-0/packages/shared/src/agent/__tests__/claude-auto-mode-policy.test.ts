/**
 * **P3.94 and P3.95, offline.** The prose rules and the one-seam composer, plus
 * the static half of P3.95 — the two vendored artefacts' disagreement about the
 * `autoMode` feature gate, pinned so a future SDK bump that flips either side
 * fails here instead of in a session.
 *
 * The dynamic half (the block actually reaching the classifier's system prompt,
 * and `managedSettings` NOT carrying it) needs the 272 MB native binary and
 * lives in `claude-auto-mode-policy-e2e.test.ts`.
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, P3.94 · P3.95.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  CLAUDE_AUTO_MODE_DEFAULTS_SPLICE,
  NESSY_DP_CREDS_DISPLAY_PATH,
  NESSY_PACKAGE_REGISTRY_HOST,
  NESSY_SOURCE_HOST,
  buildClaudeAutoModePolicySettings,
  buildClaudeFlagSettingsOptions,
  refusedClaudeManagedAutoModeKeys,
  buildClaudeSwitchModelsOnFlagSettings,
  claudeSwitchModelsInertNotice,
  CLAUDE_WORKFLOW_KEYS_WITHOUT_A_HOST_CONTROL,
} from '../claude-auto-mode-policy.ts'
// P3.186's seam lives beside the options literal it guards, in `claude-agent.ts`
// — the `settings` twin above is in this module only because it merges two
// POLICY inputs. Tested here so the two single-valued options are read side by
// side, which is the comparison that makes the pre-loaded trap visible.
import { buildClaudeManagedSettingsOptions } from '../claude-agent.ts'
import { getCredsPath } from '../../auth/dp/creds-store.ts'
import { NESTOR_GATEWAY_HOST } from '../../auth/nestor.ts'
import {
  WORKFLOW_SETTINGS_DEFAULTS,
  type ResolvedWorkflowSettings,
} from '../../config/workflow-settings.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..')

describe('the autoMode policy block', () => {
  test('every array leads with the $defaults splice, so our rules APPEND', () => {
    // The splice is the whole reason these rules are additive. A rule array that
    // forgot it would silently REPLACE Anthropic's built-in list — a strictly
    // weaker classifier that still reports success.
    const { autoMode } = buildClaudeAutoModePolicySettings({ gatewayUpstream: true })
    for (const [name, rules] of Object.entries(autoMode)) {
      // The block's fifth field is a BOOLEAN band control, not a prose array,
      // and the splice rule is about prose only (P6.191).
      if (!Array.isArray(rules)) continue
      expect(rules?.[0], `${name} must lead with the splice`).toBe(CLAUDE_AUTO_MODE_DEFAULTS_SPLICE)
      expect(rules!.length, `${name} must carry a rule of our own`).toBeGreaterThan(1)
    }
  })

  test('`allow` is absent — the recorded null, not an unfinished list', () => {
    // An allow rule can only WIDEN what the classifier permits. We measured no
    // class of action that earns one, and the header says so; this pins the
    // decision so a later reader does not "complete" the set by accident.
    const { autoMode } = buildClaudeAutoModePolicySettings({ gatewayUpstream: true })
    expect(autoMode.allow).toBeUndefined()
  })

  test('neither classifyAllShell nor the opt-in consent flag is written OF OUR OWN ACCORD', () => {
    // `classifyAllShell` multiplies the cost P3.139 is an owner decision about;
    // `skipAutoPermissionPrompt` records that the USER accepted the auto-mode
    // dialog, so writing it would forge a consent.
    //
    // REWRITTEN by P6.191, and the rewrite is the point: the old pin said the
    // key is never written, which also pinned the DEFECT — an administrator's
    // documented `autoMode.classifyAllShell` reached nothing on the one runtime
    // whose classifier is native. What must never be written is a value WE
    // chose; the administrator's own value is carried by the arm below.
    const settings = buildClaudeAutoModePolicySettings({
      gatewayUpstream: true,
      managedAutoMode: undefined,
    })
    const serialized = JSON.stringify(settings)
    expect(serialized).not.toContain('classifyAllShell')
    expect(serialized).not.toContain('skipAutoPermissionPrompt')
    expect(serialized).not.toContain('useAutoModeDuringPlan')
  })

  test("an administrator's classifyAllShell IS carried, and only its restrictive pole (P6.191)", () => {
    // `settings.md`, the key's own row: "**Default**: `false`. When `true`,
    // suspends every Bash and PowerShell allow rule while auto mode is active,
    // so all shell commands route through the classifier." Native-first: the
    // binary owns this band, so the host projects the setting instead of
    // re-implementing the suspension on this runtime.
    const on = buildClaudeAutoModePolicySettings({
      gatewayUpstream: true,
      managedAutoMode: { classifyAllShell: true },
    })
    expect(on.autoMode.classifyAllShell).toBe(true)

    // `false` and unset are the same thing on the SDK side — `false` is the
    // documented default there — so neither travels, and a floor never grants.
    for (const managedAutoMode of [{ classifyAllShell: false }, {}] as const) {
      const off = buildClaudeAutoModePolicySettings({ gatewayUpstream: true, managedAutoMode })
      expect(off.autoMode.classifyAllShell).toBeUndefined()
      expect(JSON.stringify(off)).not.toContain('classifyAllShell')
    }

    // REWRITTEN by P6.541 for the reason the P6.191 rewrite above was: the old
    // assertion pinned the DEFECT. Three of the four prose arrays now travel
    // from the administrator's block; `allow` still does not, because carrying
    // it would widen and a floor never grants.
    const withProse = buildClaudeAutoModePolicySettings({
      gatewayUpstream: true,
      managedAutoMode: { allow: ['anything goes'], hard_deny: ['org rule'] },
    }).autoMode
    expect(withProse.allow).toBeUndefined()
    expect(withProse.hard_deny!.join('\n')).toContain('org rule')
    expect(withProse.hard_deny!.join('\n')).not.toContain('anything goes')
  })

  test('the gateway sentence is scoped to a session whose upstream IS the gateway', () => {
    // Mirrors the standing rule that Nestor-specific behaviour stays scoped to
    // the verified gateway: a BYO endpoint must not be told that traffic to a
    // T-Bank host is its own normal model traffic.
    const gateway = buildClaudeAutoModePolicySettings({ gatewayUpstream: true }).autoMode
    const byo = buildClaudeAutoModePolicySettings({ gatewayUpstream: false }).autoMode
    expect(gateway.environment!.join('\n')).toContain(NESTOR_GATEWAY_HOST)
    expect(byo.environment!.join('\n')).not.toContain(NESTOR_GATEWAY_HOST)
    // The two hosts that are true of every install stay on both arms.
    for (const rules of [gateway.environment!, byo.environment!]) {
      expect(rules.join('\n')).toContain(NESSY_SOURCE_HOST)
      expect(rules.join('\n')).toContain(NESSY_PACKAGE_REGISTRY_HOST)
    }
  })

  test('the credential boundary is hard, its destruction is soft, and both name the file', () => {
    // Hard vs soft is not decoration: the binary's own schema reserves hard for
    // "security boundaries that user intent does NOT clear", and "print my token
    // to debug" is exactly the intent that must not clear disclosure. Deleting
    // the file IS clearable by "log me out everywhere".
    const { autoMode } = buildClaudeAutoModePolicySettings({ gatewayUpstream: true })
    expect(autoMode.hard_deny!.join('\n')).toContain(NESSY_DP_CREDS_DISPLAY_PATH)
    expect(autoMode.hard_deny!.join('\n')).toContain('Nestor-Token')
    expect(autoMode.soft_deny!.join('\n')).toContain(NESSY_DP_CREDS_DISPLAY_PATH)
    expect(autoMode.soft_deny!.join('\n')).toContain('nessy-cli')
  })
})

describe("P6.541 — the administrator's own autoMode prose reaches the claude classifier", () => {
  test("POSITIVE: environment, hard_deny and soft_deny are appended, and a repeated $defaults is dropped", () => {
    // The row's whole subject. Before this, the builder read ONLY
    // `classifyAllShell` and the four prose arrays were dropped — an
    // administrator's policy on the one runtime with a native classifier.
    const base = buildClaudeAutoModePolicySettings({ gatewayUpstream: false }).autoMode
    const { autoMode } = buildClaudeAutoModePolicySettings({
      gatewayUpstream: false,
      managedAutoMode: {
        // The administrator repeats the sentinel, which is the documented way to
        // say "keep the built-ins". Ours already leads with it, so a second
        // splice would duplicate every one of Anthropic's built-in rules.
        environment: ['$defaults', 'nexus.example.com is our artifact mirror.'],
        hard_deny: ['Never touch /etc/corp-secrets.'],
        soft_deny: ['Dropping a production table is destructive.'],
      },
    })
    expect(autoMode.environment).toEqual([...base.environment!, 'nexus.example.com is our artifact mirror.'])
    expect(autoMode.hard_deny).toEqual([...base.hard_deny!, 'Never touch /etc/corp-secrets.'])
    expect(autoMode.soft_deny).toEqual([...base.soft_deny!, 'Dropping a production table is destructive.'])
    // The sentinel survives UNRESOLVED and appears exactly once per section:
    // on this runtime it is the vendor's own splice instruction, not something
    // to expand locally the way the Pi path does.
    for (const section of [autoMode.environment, autoMode.hard_deny, autoMode.soft_deny]) {
      expect(section!.filter(entry => entry === CLAUDE_AUTO_MODE_DEFAULTS_SPLICE)).toHaveLength(1)
    }
  })

  test('NEGATIVE: `allow` is withheld and REFUSED BY NAME, and it drags nothing else down', () => {
    // A floor never grants, on any runtime. The failure this guards is the
    // silent one: the administrator's exception simply would not apply and the
    // classifier would keep denying with nothing said.
    const { autoMode } = buildClaudeAutoModePolicySettings({
      gatewayUpstream: false,
      managedAutoMode: { allow: ['Deleting build artifacts is fine.'], hard_deny: ['No shelling out.'] },
    })
    expect(autoMode.allow).toBeUndefined()
    // The valid sets in the SAME block still travel — refusing one key must not
    // cost the administrator the rest of their policy.
    expect(autoMode.hard_deny).toContain('No shelling out.')

    expect(refusedClaudeManagedAutoModeKeys({ allow: [] })).toEqual(['allow'])
    expect(refusedClaudeManagedAutoModeKeys({ hard_deny: ['x'] })).toEqual([])
    expect(refusedClaudeManagedAutoModeKeys(undefined)).toEqual([])
    // P6.613 owns the SENTENCE, on the durable operator channel and in both
    // locales — `chat.managedPolicy.autoModeAllowWithheld`. This module owns
    // only the verdict, so the two cannot drift.
  })

  test('the spawn says it: the refusal is emitted beside the managed diagnostics', () => {
    // The producer is `ClaudeAgent.chatImpl`, which needs a live SDK subprocess,
    // so the wiring is pinned by source match — the same instrument
    // `claude-managed-settings.test.ts` uses for this literal.
    const source = readFileSync(join(import.meta.dir, '..', 'claude-agent.ts'), 'utf8')
    const at = (needle: string): number => {
      const index = source.indexOf(needle)
      expect(index, `missing source anchor: ${needle}`).toBeGreaterThanOrEqual(0)
      return index
    }
    expect(at('refusedClaudeManagedAutoModeKeys(managedPiPolicyFloor?.autoMode)'))
      .toBeLessThan(at('const options: Options = {'))
  })
})

describe('the rules name artefacts that still exist', () => {
  // A prose rule naming a host nobody uses any more is worse than no rule: it
  // teaches the classifier that a stale host is trusted. Each fact is re-read
  // from the artefact it was taken from rather than trusted as a literal.

  test('the registry host still matches the checked-in bunfig.toml', () => {
    const bunfig = readFileSync(join(REPO_ROOT, 'bunfig.toml'), 'utf8')
    expect(bunfig).toContain('registry = ')
    expect(bunfig).toContain(NESSY_PACKAGE_REGISTRY_HOST)
  })

  test('the credential display path still matches the resolved creds path', () => {
    // `getCredsPath()` is `<home>/.nessy/dp_auth_creds.json`; the rule writes the
    // `~` form because that is what belongs in prose. If the store ever moves,
    // this fails rather than leaving the classifier guarding a path nobody writes.
    expect(getCredsPath().endsWith(NESSY_DP_CREDS_DISPLAY_PATH.replace('~/', '/'))).toBe(true)
  })
})

describe('buildClaudeFlagSettingsOptions — the single seam onto Options.settings', () => {
  /**
   * **The regression this file exists for.** `settings` is one option. Before
   * this composer, P3.147's credential floor was spread into the options literal
   * directly; a second `...{ settings }` beside it would have REPLACED it, with
   * no error and no log line, deleting the credential floor from the spawn.
   */
  test('both contributors survive the merge', () => {
    const merged = buildClaudeFlagSettingsOptions({
      deniedPathSettings: { permissions: { deny: ['Read(//home/u/.nessy/dp_auth_creds.json)'] } },
      autoModeSettings: buildClaudeAutoModePolicySettings({ gatewayUpstream: true }),
    })
    const settings = merged.settings as { permissions?: unknown; autoMode?: unknown }
    expect(settings.permissions).toEqual({ deny: ['Read(//home/u/.nessy/dp_auth_creds.json)'] })
    expect(settings.autoMode).toBeDefined()
  })

  test('either contributor alone still lands', () => {
    // `workflowSettings` is passed explicitly on the key-set assertions so they
    // stay a statement about the composer rather than about whatever workflow
    // settings the machine running the suite happens to have (P6.319).
    const denyOnly = buildClaudeFlagSettingsOptions({
      deniedPathSettings: { permissions: { deny: ['Read(//x)'] } },
      workflowSettings: WORKFLOW_SETTINGS_DEFAULTS,
    })
    expect(Object.keys(denyOnly.settings as object).sort())
      // `autoContinueAtUsageLimit` is P7.13's unconditional key — see the
      // posture test below for why it is sent on every spawn.
      // `enableWorkflows` joined them at C3.116: the host's own workflows answer
      // now travels in BOTH directions, because the vendor's unset is the user's
      // Anthropic PLAN rather than an off (`claude-workflow-engine-reachability.test.ts`).
      // `skillOverrides` joined at C3.326 (`8d1b5f0ad`): the bundled `/batch` is
      // off on claude through the vendor's own per-skill key. That commit did not
      // move these three pins and they were RED at HEAD; found by C3.380's lift
      // gate on 2026-09-13 and repaired here, not by the lift.
      .toEqual(['autoContinueAtUsageLimit', 'enableWorkflows', 'feedbackDrafts', 'permissions', 'skillOverrides'])
    const autoOnly = buildClaudeFlagSettingsOptions({
      autoModeSettings: buildClaudeAutoModePolicySettings({ gatewayUpstream: false }),
      workflowSettings: WORKFLOW_SETTINGS_DEFAULTS,
    })
    expect(Object.keys(autoOnly.settings as object).sort())
      .toEqual(['autoContinueAtUsageLimit', 'autoMode', 'enableWorkflows', 'feedbackDrafts', 'skillOverrides'])
  })

  /**
   * P6.583 — the vendor's `feedbackDrafts` default is `"notify"`, which nobody
   * in this fork chose. It is now `"off"` on the flag tier, unconditionally, so
   * the assertion that used to read "no option at all" reads "the posture and
   * nothing else". A session with no rules on either contributor still carries
   * exactly these keys — remove either constant and this goes red.
   *
   * P7.13 added the second unconditional key, and it is unconditional for a
   * DIFFERENT reason from the workflow keys three tests down — worth stating
   * here, because the two rules look contradictory and are not.
   *
   * The workflow guideline is omitted at our default because omitting it leaves
   * the vendor's own documented default in force and keeps a /config row the
   * user owns. `autoContinueAtUsageLimit` has no such fallback: with the key
   * absent the child takes `autoContinueKeyPresence === "absent"`, a heuristic
   * over stored state this host can neither observe nor reproduce. And unlike
   * the workflow guideline, this host PRINTS A SENTENCE about what will happen
   * ("Waiting until …, then continuing automatically") — a promise the host
   * makes must rest on an instruction the host gave, not on a heuristic. So the
   * definite answer travels on every spawn, and the sentence and the child agree
   * by construction.
   */
  test('with no rules on either contributor the posture is still the whole option', () => {
    expect(buildClaudeFlagSettingsOptions({ workflowSettings: WORKFLOW_SETTINGS_DEFAULTS }))
      // `skillOverrides` is C3.326's unconditional posture, on the same footing
      // as the other three — see the key-list test above.
      .toEqual({
        settings: {
          feedbackDrafts: 'off',
          skillOverrides: { batch: 'off' },
          autoContinueAtUsageLimit: true,
          enableWorkflows: true,
        },
      })
  })

  /**
   * The tier is a MEASUREMENT, not a preference: the SDK's restrictive
   * managed-settings filter does not copy `feedbackDrafts`, so projecting it
   * through `managedSettings` would be a silent drop. Pinning it here keeps a
   * later lane from "tidying" it into the managed mapper.
   */
  test('the posture rides Options.settings, which applies unconditionally', () => {
    const settings = buildClaudeFlagSettingsOptions({
      deniedPathSettings: { permissions: { deny: ['Read(//x)'] } },
      workflowSettings: WORKFLOW_SETTINGS_DEFAULTS,
    }).settings as { feedbackDrafts?: string }
    expect(settings.feedbackDrafts).toBe('off')
  })

  /**
   * P6.319 — the three workflow keys the vendored SDK declares and we passed
   * none of. `sdk.d.ts:5678/:5682/:5686` on `Settings`; native-first step 1, so
   * the host's already-resolved answer is handed to the runtime's own switches
   * rather than a second implementation being written.
   */
  describe('the workflow keys reach the runtime, and only what the host decided (P6.319)', () => {
    const flags = (settings: ResolvedWorkflowSettings) =>
      buildClaudeFlagSettingsOptions({ workflowSettings: settings }).settings as Record<string, unknown>

    test('the host default sends no GUIDELINE, so the /config row the vendor hides stays the user\'s', () => {
      // The SDK's own doc: a value here "takes precedence over the 'Dynamic
      // workflow size' choice in /config, and that /config row is hidden while a
      // settings file provides the key". Our default is `unrestricted` and the
      // vendor's is `medium` — a divergence this fork keeps deliberately (see
      // the builder) rather than seizing a user control with a default nobody
      // chose.
      expect(Object.keys(flags(WORKFLOW_SETTINGS_DEFAULTS)))
        // No GUIDELINE key. `enableWorkflows` is here for the C3.116 reason the
        // builder's docblock gives, and the other two are the unconditional
        // postures the test above explains.
        .toEqual(['feedbackDrafts', 'skillOverrides', 'autoContinueAtUsageLimit', 'enableWorkflows'])
    })

    test('an explicit guideline travels, at every non-default value', () => {
      for (const sizeGuideline of ['small', 'medium', 'large'] as const) {
        expect(flags({ ...WORKFLOW_SETTINGS_DEFAULTS, sizeGuideline }).workflowSizeGuideline)
          .toBe(sizeGuideline)
      }
    })

    /**
     * **C3.116 (QH9, owner answer B) — the ON direction, which is the row.**
     *
     * The positive half. Before this row only the off travelled, on the reading
     * that "an on is our default"; C3.115 measured the vendor's unset to be
     * `defaultOn = we()!=="pro"` — the user's Anthropic PLAN — so our default and
     * the vendor's disagree for a Pro subscriber and the host's answer has to be
     * definite. Same shape as `autoContinueAtUsageLimit` beside it.
     */
    test('the host\'s workflows-ON answer now travels, definitely', () => {
      const on = flags({ disableWorkflows: false, sizeGuideline: 'unrestricted', keywordTriggerEnabled: true })
      expect(on.enableWorkflows).toBe(true)
      // The keyword trigger is the key where our default and the vendor's AGREE
      // (`Default: true`), so an on is still not sent — the asymmetry
      // `restrictiveTrue` keeps on the managed mapper, narrowed to one key.
      expect(on).not.toHaveProperty('workflowKeywordTriggerEnabled')
    })

    /**
     * The negative half, and the promise the owner's answer required to be kept
     * "exactly as it is": the restrictive off-switch still reaches the runtime.
     * A mutation dropping the `!` in the builder turns this red and leaves the
     * test above green, which is why the two are a pair.
     */
    test('the host\'s workflows-OFF answer still wins, unchanged', () => {
      const off = flags({ disableWorkflows: true, sizeGuideline: 'unrestricted', keywordTriggerEnabled: false })
      expect(off.enableWorkflows).toBe(false)
      expect(off.workflowKeywordTriggerEnabled).toBe(false)
      // ...and the two directions are actually different, so neither assertion
      // can be satisfied by a constant.
      expect(off.enableWorkflows)
        .not.toBe(flags({ disableWorkflows: false, sizeGuideline: 'unrestricted', keywordTriggerEnabled: true }).enableWorkflows)
    })

    test('the credential floor still survives beside them', () => {
      // Same regression this describe block exists for: `settings` is ONE option.
      const merged = buildClaudeFlagSettingsOptions({
        deniedPathSettings: { permissions: { deny: ['Read(//x)'] } },
        workflowSettings: { disableWorkflows: true, sizeGuideline: 'large', keywordTriggerEnabled: false },
      }).settings as Record<string, unknown>
      expect(merged.permissions).toEqual({ deny: ['Read(//x)'] })
      expect(merged.workflowSizeGuideline).toBe('large')
    })

    test('the ONE key still without a host control is recorded rather than invented', () => {
      // Declared on the same `Settings` interface (`:7222`) and readable by
      // nothing in this fork, so there is no input to drop — an absent host
      // control, named so it is not rediscovered as a defect. Its twin
      // `switchModelsOnFlag` LEFT this list in P6.370, which is what the block
      // below tests; a mutation putting it back makes both go red.
      expect(CLAUDE_WORKFLOW_KEYS_WITHOUT_A_HOST_CONTROL)
        .toEqual(['fastModePerSessionOptIn'])
      const anything = flags({ disableWorkflows: true, sizeGuideline: 'small', keywordTriggerEnabled: false })
      for (const key of CLAUDE_WORKFLOW_KEYS_WITHOUT_A_HOST_CONTROL) {
        expect(anything).not.toHaveProperty(key)
      }
    })
  })

  /**
   * P6.370 — the control P6.319 said had to exist before the projection could,
   * and the two facts that make it correct rather than merely present: it binds
   * ONLY on a direct-Anthropic connection, and it rides `Options.settings`
   * because the managed tier would silently drop it.
   */
  describe('switchModelsOnFlag — the user\'s answer, projected where it binds', () => {
    test('an explicit off travels on the DIRECT path', () => {
      expect(buildClaudeSwitchModelsOnFlagSettings({ directAnthropic: true, configured: false }))
        .toEqual({ switchModelsOnFlag: false })
      // ...and through the one seam, beside the contributors it must not delete.
      const merged = buildClaudeFlagSettingsOptions({
        switchModelsSettings: buildClaudeSwitchModelsOnFlagSettings({ directAnthropic: true, configured: false }),
        deniedPathSettings: { permissions: { deny: ['Read(//x)'] } },
        workflowSettings: WORKFLOW_SETTINGS_DEFAULTS,
      }).settings as Record<string, unknown>
      expect(merged.switchModelsOnFlag).toBe(false)
      expect(merged.permissions).toEqual({ deny: ['Read(//x)'] })
    })

    test('the same off does NOT travel on the loopback path, and says so', () => {
      // The negative case, and the one a mutation removing the `directAnthropic`
      // condition turns red. A `claude-runtime` connection — the gateway card or
      // a BYO endpoint — reaches its endpoint through our loopback adapter,
      // which runs no safety classifier, so there is nothing to flag.
      expect(buildClaudeSwitchModelsOnFlagSettings({ directAnthropic: false, configured: false }))
        .toEqual({})
      const merged = buildClaudeFlagSettingsOptions({
        switchModelsSettings: buildClaudeSwitchModelsOnFlagSettings({ directAnthropic: false, configured: false }),
        workflowSettings: WORKFLOW_SETTINGS_DEFAULTS,
      }).settings as Record<string, unknown>
      expect(merged).not.toHaveProperty('switchModelsOnFlag')
      // ...and the user who set it is told, rather than left with a control
      // that looks applied and is not.
      const notice = claudeSwitchModelsInertNotice({ directAnthropic: false, configured: false })
      expect(notice).toBeDefined()
      expect(notice).toContain('switchModelsOnFlag')
    })

    test('unset and explicit-on both project NOTHING, and say nothing', () => {
      // The whole existing world. The vendor's own default is ON, so emitting
      // `true` would be a change dressed as a no-op, and an install that never
      // touched the key must spawn byte-identically to one built before the row.
      for (const configured of [undefined, true] as const) {
        expect(buildClaudeSwitchModelsOnFlagSettings({ directAnthropic: true, configured })).toEqual({})
        expect(claudeSwitchModelsInertNotice({ directAnthropic: false, configured })).toBeUndefined()
      }
    })

    test('the SDK managed tier cannot carry it — measured, not remembered', () => {
      // Why this rides `Options.settings`. The restrictive managed-settings
      // TABLE (`{path:[...],restrictive:...}` rows) is what the SDK managed tier
      // can carry; `powershell-tool-settings-route.test.ts` reads the same table
      // for the same reason (P6.688's `env`). F1.255 (0.3.267): it no longer
      // follows `parentSettingsBehavior==="merge"` (now twice in the file), so it
      // is anchored by its own first row, which occurs once in 0.3.251 and 0.3.267.
      const require_ = createRequire(import.meta.url)
      const sdkRoot = dirname(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'))
      const sdk = readFileSync(join(sdkRoot, 'sdk.mjs'), 'utf8')
      const anchor = '{path:["allowManagedPermissionRulesOnly"],restrictive:'
      const at = sdk.indexOf(anchor)
      expect(at).toBeGreaterThan(-1)
      expect(sdk.indexOf(anchor, at + 1)).toBe(-1)
      expect(sdk[at - 1]).toBe('[')
      // D1.111 — the table's OWN brackets, not a 2 000-character window, and on a
      // MINIFIED bundle that is the only honest bound: `bracedRegion` is for code
      // whose braces balance textually, which a minified file's strings do not.
      // Measured by the sibling that reads this identical table
      // (`powershell-tool-settings-route.test.ts`) at SDK `0.3.247`: it is 3 315
      // characters, so the old window read 60 % of it and a row appended in the
      // last third would have been missed — the SILENT direction, since the
      // finding below is a negative. The minified binding name rots with every
      // SDK build, so the bound is the table's own `[`, the character before its first row.
      const open = at - 1
      let depth = 0
      let close = -1
      for (let index = open; index < sdk.length; index += 1) {
        if (sdk[index] === '[') depth += 1
        else if (sdk[index] === ']') {
          depth -= 1
          if (depth === 0) { close = index; break }
        }
      }
      expect(close).toBeGreaterThan(open)
      const filterBody = sdk.slice(open, close + 1)
      // BOUNDARY CONTROL: the region really is the table and not the rest of a
      // 1.4 MB bundle, which carries `switchModelsOnFlag` elsewhere.
      expect(filterBody.endsWith(']')).toBe(true)
      expect(filterBody.length).toBeLessThan(20_000)
      // Positive controls, so a filter body that failed to load cannot make the
      // finding below vacuously true.
      expect(filterBody).toContain('permissions')
      expect(filterBody).toContain('allowManagedHooksOnly')
      // ...and the finding.
      expect(filterBody).not.toContain('switchModelsOnFlag')
    })

    test('the CALL SITE exists, and reads the connection the right way round', () => {
      // P6.370's remaining half (W9-j → W9-m). Both halves above are pure
      // functions: with no caller they are a control that looks built and binds
      // nothing, which is exactly the defect class the row names. This pins the
      // wiring in `chatImpl` — the projection AND the notice — because a unit
      // test of the builders cannot see a missing argument.
      const agentSource = readFileSync(join(import.meta.dir, '..', 'claude-agent.ts'), 'utf8')
      // Positive control: the file loaded and carries the sibling contributor
      // this one sits beside, so an absence below cannot be a bad read.
      expect(agentSource).toContain('autoModeSettings: buildClaudeAutoModePolicySettings({')
      expect(agentSource).toContain('switchModelsSettings: buildClaudeSwitchModelsOnFlagSettings({')
      expect(agentSource).toContain('claudeSwitchModelsInertNotice({')
      // The direction. `claudeRuntimeUpstreamKind` is set only on the
      // `claude-runtime` loopback path, so `=== null` IS direct-Anthropic; the
      // sibling line a few characters above uses `=== 'nestor'`, and passing
      // THAT here would invert the control — off would travel on the one
      // connection where it cannot bind and be dropped where it can.
      const projection = agentSource.slice(
        agentSource.indexOf('switchModelsSettings: buildClaudeSwitchModelsOnFlagSettings({'),
      ).slice(0, 200)
      expect(projection).toContain('directAnthropic: this.claudeRuntimeUpstreamKind === null')
      expect(projection).not.toContain("=== 'nestor'")
    })
  })
})

/**
 * **P3.95's static half.** The row's blocker: the vendored `sdk.mjs` gates the
 * `autoMode` feature schema OFF while the shipped binary gates it ON. Measured
 * true on 0.3.223 / 2.1.223, and INERT — the JS layer never applies its
 * feature-gated schema to `Options.settings` (see the e2e sibling, which proves
 * the block reaches the classifier's prompt anyway).
 *
 * This pins the disagreement itself. A future bump that flips EITHER side is
 * worth knowing about: the binary going OFF would silently retire the whole
 * mechanism, and the JS layer going ON would mean its schema starts mattering.
 */
function vendoredSdkPaths(): { sdk: string; binary: string } | null {
  try {
    const require_ = createRequire(import.meta.url)
    const sdkRoot = dirname(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'))
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const suffix = process.platform === 'win32' ? 'claude.exe' : 'claude'
    return {
      sdk: join(sdkRoot, 'sdk.mjs'),
      binary: join(dirname(sdkRoot), `claude-agent-sdk-${process.platform}-${arch}`, suffix),
    }
  } catch {
    return null
  }
}

const PATHS = vendoredSdkPaths()

describe.if(PATHS !== null && existsSync(PATHS.sdk))('the vendored sdk.mjs feature gate', () => {
  test('gates the autoMode schema OFF, with an empty shape', () => {
    const source = readFileSync(PATHS!.sdk, 'utf8')
    expect(source).toContain('autoMode:{buildGate:()=>!1')
    // Positive control on the same read: a sibling feature IS gated on, so a
    // match on `!1` is a fact about `autoMode` and not about the whole table.
    expect(source).toContain('voice:{buildGate:()=>!0')
  })
})

describe.if(
  PATHS !== null && existsSync(PATHS.binary) && process.platform !== 'win32',
)('the shipped native binary feature gate', () => {
  // The artefact is ~272 MB, so ONE pass collects every fragment at once: six
  // separate `grep` invocations cost ~2.7 s each and blew bun's default 5 s
  // per-test window. `-F` keeps the patterns literal, `-o` prints each hit.
  const WANTED = [
    'autoMode:{buildGate:()=>!0',
    'soft_deny:',
    'hard_deny:',
    'classifyAllShell:',
    '"$defaults"',
    // Negative control for the instrument, carried in the SAME pass: if this
    // ever "matches", the search is not doing what the assertions assume.
    'nessyNotARealSdkFeatureGate',
  ] as const

  test('gates the autoMode schema ON, and carries the four prose-rule arrays', () => {
    const result = spawnSync(
      'grep',
      ['-a', '-o', '-F', ...WANTED.flatMap(pattern => ['-e', pattern]), PATHS!.binary],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    const found = new Set((result.stdout ?? '').split('\n').filter(Boolean))
    // A renamed key here is a silently ignored policy, which is the failure this
    // whole family exists to remove.
    for (const fragment of WANTED.slice(0, -1)) {
      expect(found.has(fragment), `binary must still carry ${fragment}`).toBe(true)
    }
    expect(found.has('nessyNotARealSdkFeatureGate')).toBe(false)
  }, 120_000)
})

describe('buildClaudeManagedSettingsOptions — the same seam, one option over (P3.186)', () => {
  /**
   * `Options.settings` acquired a second contributor and nearly lost the first:
   * that option is single-valued, so a second spread REPLACES rather than
   * merges, and the credential floor would have left the spawn with no error and
   * no log line. `managedSettings` has the identical shape and ONE contributor
   * today, which is what makes the trap pre-loaded rather than closed.
   */
  test('a single contributor lands unchanged, so an unmanaged install is untouched', () => {
    expect(buildClaudeManagedSettingsOptions({ a: undefined })).toEqual({})
    expect(buildClaudeManagedSettingsOptions({})).toEqual({})
    const one = buildClaudeManagedSettingsOptions({
      managedPolicyFloor: { permissions: { deny: ['Read(//x)'] } } as never,
    })
    expect(one.managedSettings).toEqual({ permissions: { deny: ['Read(//x)'] } } as never)
  })

  test('a second contributor MERGES rather than replacing the first', () => {
    // The regression this seam exists for, stated as the assertion: before it,
    // the second value would have been the only one on the wire.
    const merged = buildClaudeManagedSettingsOptions({
      first: { permissions: { deny: ['Read(//x)'] } } as never,
      second: { disableAllHooks: true } as never,
    })
    const settings = merged.managedSettings as { permissions?: unknown; disableAllHooks?: unknown }
    expect(settings.permissions).toEqual({ deny: ['Read(//x)'] })
    expect(settings.disableAllHooks).toBe(true)
  })

  test('a KEY collision is refused and reported by name, never silently resolved', () => {
    // Last-writer-wins is the same defect one level down. The first writer keeps
    // the key and the caller is told which two contributors disagree — the
    // collision is a composition decision somebody has to make deliberately.
    const said: string[] = []
    const merged = buildClaudeManagedSettingsOptions({
      floor: { disableAllHooks: true } as never,
      later: { disableAllHooks: false } as never,
    }, line => said.push(line))
    expect((merged.managedSettings as { disableAllHooks?: unknown }).disableAllHooks).toBe(true)
    expect(said.join('\n')).toContain('disableAllHooks')
    expect(said.join('\n')).toContain('floor')
    expect(said.join('\n')).toContain('later')
  })

  test('P6.688 POSITIVE — two `permissions` writers UNION their deny lists', () => {
    // The refusal rule created this case and would have broken the row it was
    // asked to close: the administrator's own rules and the product's
    // PowerShell floor both write `permissions`, so refusing the second drops
    // the floor for exactly the fleets that HAVE an administrator. Both lists
    // are restrictions; the union is the only composition that keeps both.
    const said: string[] = []
    const merged = buildClaudeManagedSettingsOptions({
      managedPolicyFloor: { permissions: { deny: ['Read(//x)'], ask: ['Bash(rm *)'] } } as never,
      productPowerShellToolFloor: { permissions: { deny: ['PowerShell'] } } as never,
    }, line => said.push(line))
    const permissions = (merged.managedSettings as { permissions?: { deny?: string[]; ask?: string[] } })
      .permissions
    expect(permissions?.deny).toEqual(['Read(//x)', 'PowerShell'])
    // The sub-key only ONE contributor wrote survives untouched.
    expect(permissions?.ask).toEqual(['Bash(rm *)'])
    // Said out loud, not silently resolved — the seam's own posture.
    expect(said.join('\n')).toContain('UNIONED')
    expect(said.join('\n')).toContain('productPowerShellToolFloor')
  })

  test('P6.688 NEGATIVE — a WIDENING sub-key is still refused and named', () => {
    // The boundary. `allow` and `additionalDirectories` hand capability OUT, so
    // unioning them would make this seam the last-writer-wins it exists to
    // prevent. The first writer keeps them and the second is named.
    const said: string[] = []
    const merged = buildClaudeManagedSettingsOptions({
      managedPolicyFloor: { permissions: { deny: ['Read(//x)'], allow: ['Bash(ls)'] } } as never,
      later: { permissions: { deny: ['PowerShell'], allow: ['Bash(curl *)'] } } as never,
    }, line => said.push(line))
    const permissions = (merged.managedSettings as { permissions?: { deny?: string[]; allow?: string[] } })
      .permissions
    expect(permissions?.deny).toEqual(['Read(//x)', 'PowerShell'])
    expect(permissions?.allow).toEqual(['Bash(ls)'])
    expect(said.join('\n')).toContain('allow')
    expect(said.join('\n')).toContain('NOT merged')
  })

  test('THE CONTROL — disjoint keys report nothing', () => {
    // Without this the assertion above cannot tell "a collision is reported"
    // from "every merge reports", and the second would fill an operator's log
    // with a warning about a composition that is fine.
    const said: string[] = []
    buildClaudeManagedSettingsOptions({
      first: { permissions: {} } as never,
      second: { disableAllHooks: true } as never,
    }, line => said.push(line))
    expect(said).toEqual([])
  })
})
