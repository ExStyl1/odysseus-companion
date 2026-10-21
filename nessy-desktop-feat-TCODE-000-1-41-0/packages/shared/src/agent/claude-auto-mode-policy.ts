/**
 * **P3.94 — the classifier we already enable, finally told what deployment it
 * is judging.** And **P3.95 — the measurement that made it buildable.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, rows P3.94 and
 * P3.95. This is the codex `[auto_review].policy` move, on Claude: the native
 * mechanism exists, we already switch it on, and until now we handed it nothing.
 *
 * ## What was already true, and is not re-derived here
 *
 * P3.58 · `permissionMode: 'auto'` runs a separate classifier model that
 * reviews tool calls before they run, and `CLAUDE_SDK_PERMISSION_MODE_TABLE`
 * already maps our `auto` onto the SDK's `'auto'`.
 * P3.96 · auto mode is AVAILABLE on the gateway card — the binary's gate is a
 * DENY list of legacy ids, so `tgpt/qwen35-397b-a17b-fp8` reports
 * `supportsAutoMode: true`.
 * P3.121 · the gateway can answer the classifier: 28 of 28 responses parsed,
 * in both directions.
 * P3.93 · **and our own PreToolUse `allow` silences it entirely.** That is the
 * honest limit of this module and it is stated again below.
 *
 * ## P3.95, measured on the vendored artefacts (2026-08-28)
 *
 * The row's blocker was real and it is now settled. The two artefacts DO
 * disagree, exactly as the row said:
 *
 * - `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` carries
 *   `autoMode:{buildGate:()=>!1,shape:()=>KR}` — gate OFF, and the shape is the
 *   shared EMPTY object.
 * - `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` carries
 *   `autoMode:{buildGate:()=>!0,shape:()=>({…autoMode:{allow,soft_deny,
 *   hard_deny,environment,classifyAllShell}…})}` — gate ON, full schema.
 *
 *   (Re-measured on the vendored `0.3.247` / `2.1.247` on 2026-09-12 (C3.252)
 *   and unchanged in substance; before that on `0.3.233` / `2.1.233` after the S0-3 bump; the
 *   two versions were `0.3.223` / `2.1.223` when this was first written, and
 *   the empty-shape identifier moved from `eO` to `KR` with nothing failing.
 *   Read these by their SHAPE — `buildGate:()=>!1` beside an empty
 *   `shape:()=>` — never by the minified name, which the next bump renames.)
 *
 * **And the disagreement is INERT for `Options.settings`.** The JS layer's
 * feature-gated schema (`Es()` / `cO()`) is its own settings-FILE reader; it is
 * never applied to `Options.settings`, which is forwarded to the binary as
 * `--settings`. Measured three ways, binary pinned and every `CLAUDE*`/
 * `ANTHROPIC*` key scrubbed:
 *
 * 1. **Positive**: with this policy passed, the three marker sentences appear
 *    VERBATIM inside the classifier's own ~110 KB system prompt as captured off
 *    the wire (110,511 chars → 110,713 with the markers spliced in).
 * 2. **Negative control**: the same run with no `settings` carries none of them.
 * 3. **The other tier does NOT carry it**: the same block sent as
 *    `managedSettings` reaches the classifier prompt not at all — the SDK's
 *    restrictive-only filter has no `autoMode` branch (see
 *    `claude-managed-settings.ts` for that filter, read out of the binary).
 *    `settings` is the only seam, and 1 is 3's positive control.
 *
 * The literal argv was captured through a wrapper `pathToClaudeCodeExecutable`:
 * an object and a `JSON.stringify` of the same object produce a byte-identical
 * `--settings` payload, under **both** Bun and Node 24 (the Electron main
 * process is Node, so the two had to be checked separately — a serialization
 * that only happens under one runtime would be a mirror that works in tests and
 * is inert in the shipped app). The object form is kept because P3.147 already
 * ships it. One hazard recorded rather than guessed: the SDK's sandbox branch
 * calls `.trim()` on `Options.settings`, so an object settings value would
 * throw if `Options.sandbox` were ever passed — it is not passed anywhere in
 * `claude-agent.ts`, and isolation is off by standing owner decision.
 *
 * ## What this module does NOT do, said plainly
 *
 * **It does not make the classifier run.** P3.93 measured that our PreToolUse
 * hook's `permissionDecision: 'allow'` skips the permission prompt, which in
 * auto mode IS the classifier; `buildClaudePreToolUseContinue` names `allow` or
 * `ask` on every path, so the only fall-through returns left in the hook are two
 * defensive guards (a non-`PreToolUse` event, and a missing `tool_name` /
 * `tool_use_id`). In the shipped configuration the classifier is therefore
 * consulted on approximately nothing.
 *
 * **CONFIRMED by the owner on 2026-09-11 (QA1 = C), which is why the sentence
 * above is a recorded refusal and not a defect report.** The question asked
 * whether to wire claude's native classifier into a path that actually consults
 * it; the answer is to refuse and say so. The only route measured to reach it is
 * the `hookAskFloor` path plus an ask RULE, sized M and larger, and the one
 * S-looking route — projecting the managed `classifyAllShell` into
 * `Options.settings` — was measured INERT for exactly the reason above: our
 * PreToolUse `allow` skips the prompt before the classifier is consulted
 * (P3.93 / P3.96, `b0e6f0044`). So on claude the judging is done by OUR
 * deterministic gate, the same rules engine Pi and codex are judged by, and the
 * vendor's classifier stays configured-but-unconsulted, one flag away.
 *
 * This is still worth shipping, and the reason is not "it might help someday":
 * P3.139 is an OWNER decision about latency (median 7.5 s), cost (~24.2k input
 * tokens per hop, invisible in `modelUsage`) and verdict VARIANCE. Configuring
 * the policy is the half of that question which is not a trade-off — it costs
 * ~1 KB of argv, changes no behaviour while the classifier is unconsulted, and
 * means the day the owner answers P3.139 the mechanism turns on already knowing
 * what a T-Bank deployment looks like, instead of judging it against Anthropic's
 * generic defaults. Enabling and informing are different decisions; only one of
 * them has a cost.
 *
 * ## Why each rule earns its place
 *
 * The grammar is prose sentences in four arrays, with a `"$defaults"` literal
 * that **splices Anthropic's built-ins in at that position rather than replacing
 * them** — so every array here leads with `"$defaults"` and ours ride on top.
 * The binary's own schema says it: *"Include the literal string `$defaults` to
 * inherit the built-in rules at that position."*
 *
 * A rule is only here if it states a fact about THIS deployment that the
 * classifier cannot know and that would otherwise change a verdict. Rules
 * specific to one repository are deliberately absent — this ships to every
 * T-Bank install, and a rule about this repo's protected branches would be a
 * claim about somebody else's tree.
 *
 * - `environment` — three hosts. Anthropic's defaults recognize public
 *   infrastructure; the classifier blocks actions that "target unrecognized
 *   infrastructure". Every one of this deployment's own hosts is unrecognized
 *   to it: the model gateway, the source host, and the package registry. An
 *   ordinary `bun install` fetches executable code from `artifactory.tcsbank.ru`
 *   and an ordinary `git push` reaches `gitlab.tcsbank.ru`; both read as
 *   escalation without this. Each host is taken from a checked-in artefact, not
 *   from memory — see the constants below.
 * - `hard_deny` — one rule, the gateway credential. `~/.nessy/dp_auth_creds.json`
 *   holds the gateway JWT, is 0600, and is SHARED with nessy-cli. P3.147 already
 *   mirrors it into `permissions.deny`, which the page promises covers reads,
 *   Edit and Write — and which was MEASURED not to cover `Grep`/`Glob` results,
 *   and does not cover `Bash` at all: `cat`, `curl -d @file` and
 *   `env | grep -i token` all route around it. That Bash-shaped hole is exactly
 *   the band the classifier judges, so this rule closes a gap our own floor
 *   provably has rather than restating one it already covers. It is `hard_deny`
 *   and not `soft_deny` because the schema reserves hard for "security
 *   boundaries that user intent does NOT clear", and "print my token so I can
 *   debug" is precisely the intent that must not clear it.
 * - `soft_deny` — one rule, the same file's destruction. Deleting it signs the
 *   user out of a SECOND product they did not mention. That the file is shared
 *   is unguessable from the path, and it is what makes an `rm` here worse than
 *   an `rm` of an ordinary dotfile. Soft, because a user who says "log me out
 *   everywhere" has cleared it.
 * - `allow` — **deliberately empty, and that is a decision, not an omission.**
 *   An `allow` rule can only WIDEN what the classifier permits, and each one is
 *   a claim that we know better than Anthropic's defaults about a whole class of
 *   action. We have measured no such class. The null is recorded here so the
 *   next reader does not mistake it for an unfinished list. **P6.541 extends the
 *   same rule to the ADMINISTRATOR's `allow`**: the other three sets are now
 *   appended from the managed block, and `allow` is withheld on every runtime —
 *   `resolveAutoMode` drops a user-scope `allow` one layer down for the same
 *   reason. Withheld is not lost: `refusedClaudeManagedAutoModeKeys` names it.
 * - `classifyAllShell` — **ours is left unset (default `false`), and an
 *   ADMINISTRATOR's is now carried.** Turning it on suspends every Bash allow
 *   rule and routes every shell command through the classifier, which multiplies
 *   exactly the cost P3.122 measured and P3.139 is deciding about, so it is not
 *   ours to pre-empt. But it was also not ours to DROP: P6.191 measured every
 *   reader of the managed `autoMode` block as `provider === 'pi'` by its own
 *   term, so an administrator who set the documented key got nothing on the one
 *   runtime whose classifier is native. The builder below therefore projects the
 *   managed value — and only the managed value, and only its `true` pole.
 * - `skipAutoPermissionPrompt` — never set. The binary describes it as "whether
 *   the user has accepted the auto mode opt-in dialog". Writing it would forge a
 *   consent.
 *
 * ## P3.123 — the page is STRICTER than the artefact, recorded against the page
 *
 * `permission-modes.md` states requirements as an allow list — *"Auto mode is
 * available only when your account meets all of these requirements:"*, then
 * *"**Model**: on the Anthropic API and Claude Platform on AWS, Claude Opus 4.6
 * or later, Sonnet 4.6 or later, or a Fable model…"* and *"**Provider**:
 * available by default on the Anthropic API, Claude Platform on AWS, Amazon
 * Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, and signed-in
 * Claude apps gateway sessions."*
 *
 * The shipped binary implements neither as an allow list. Transcribed at
 * `2.1.233`, verbatim (read it by this SHAPE — every minified name below is the
 * minifier's and the lift to `2.1.247` moved them again):
 *
 *   `function mCr(e){if(e==="firstParty"||M7(e))return!0;return!0}`
 *   `function sst(e){let t=zo(e),r=Jn();if(!mCr(r))return!1;`
 *   `  if(t.includes("claude-3-")||t==="claude-opus-4-0"||t==="claude-opus-4-1"`
 *   `   ||t==="claude-opus-4-5"||t==="claude-sonnet-4-0"||t==="claude-sonnet-4-5"`
 *   `   ||t==="claude-haiku-4-5")return!1; … return!0}`
 *
 * `mCr` is the provider gate and **both of its branches return true**, so no
 * provider is excluded; `sst` is the model gate and it is a DENY list of seven
 * exact ids plus a `claude-3-` prefix, so any id it does not name — ours
 * included — is permitted. That is why P3.96 measured
 * `supportsAutoMode: true` on the gateway card while a reader of the page would
 * conclude auto mode is unavailable here.
 *
 * Recorded against the page rather than filed as a defect: it is Anthropic's
 * artefact, not ours, and `AGENTS.md`'s membership rule says which side governs
 * a *"what is the complete set of X"* question — **the shipped bundle is the
 * denominator and the documentation is a subset of it.**
 *
 * ## P3.142 — the audit asymmetry, attached to the flag it constrains
 *
 * P3.139 is CLOSED as an owner decision: the mode-conditional fall-through
 * stays OFF, one flag away. This is the condition that must travel WITH that
 * flag, because it cannot be discovered after the fact:
 *
 * **Denials are recordable and approvals are not.** A classifier denial reaches
 * us through the `PermissionDenied` hook carrying `decision_reason_type:
 * 'classifier'`, and `claude-permission-denial-receipt.ts` mints a receipt from
 * it. A classifier ALLOW reaches nothing — `canUseTool` is skipped for
 * auto-approved tools, so an action the classifier reviewed and permitted is
 * indistinguishable from one a rule permitted. For a bank deployment that is
 * the interesting half: the audit trail would show refusals and be silent about
 * the approvals that actually happened.
 *
 * Not a blocker for enabling, and deliberately not modelled as one. It is a
 * thing the operator must be TOLD before the flag moves, so it is written at
 * the flag rather than in a plan row nobody will re-read. Whoever flips the
 * fall-through owns saying it out loud.
 *
 * ## P3.97's verdict, which belongs at this flag because this flag is what
 * ## made the receipt dormant (decided 2026-09-03, W4-g)
 *
 * The receipt was held twice for one reason: the `PermissionDenied` hook is the
 * only channel carrying `tool_input`, and it fires only when the classifier
 * runs — which the fall-through above keeps OFF. **The verdict is MINT, from a
 * second channel**: `system/permission_denied` is a stream message the SDK emits
 * for every denial it decides itself, it carries `decision_reason_type` and a
 * reason, and it is live in the configuration we ship today. So
 * `claude-permission-denial-receipt.ts` now mints from BOTH, and the audit
 * record exists whether or not this flag ever moves.
 *
 * Two consequences that only make sense read beside this flag:
 *
 * 1. **The asymmetry above is unchanged and is the whole residue.** The new
 *    channel is still a REFUSAL channel. An approval — the classifier's or
 *    anyone's — still reaches nothing. Widening the audit to denials of every
 *    kind does not narrow the gap this section describes by one row.
 * 2. **Flipping the fall-through makes one denial mint TWO receipts**, one per
 *    channel, sharing a `toolUseId`: the stream one with the verbatim type and
 *    no input, the hook one with the input and a type implied by the gate. That
 *    is deliberate — the two are complementary and de-duplicating would discard
 *    one half of the record — but a consumer counting refusals must count
 *    distinct `toolUseId`s from the day this flag moves, not receipts.
 *
 * ## P3.188 — two recorded nulls, both now resolved on the vendored artefacts
 *
 * (1) **Where an object `settings` is serialised.** The earlier read stopped at
 * the argv emitter, which looks like it would produce `[object Object]` —
 * `function Tk(e,t,n){let r=String(n);…}` — and measured that it does not,
 * without finding the line responsible. It is one call frame earlier, in the
 * options normaliser that feeds the transport:
 *
 *   `settings: typeof i==="object"?Se(i):i, managedSettings: a?Se(a):void 0,`
 *
 * where `i` is the destructured `settings` and `Se` is the bundle's
 * instrumented `JSON.stringify`. So an object is stringified BEFORE
 * `this.options.settings` is ever read, which is why `String(n)` never sees
 * one, and why the object and JSON-string forms are byte-identical on the wire.
 * The `.trim()` hazard recorded above is a different function on the same value
 * (`PAe(e){let t=e.trim();return t.startsWith("{")&&t.endsWith("}")}`), reached
 * only when `Options.sandbox` is passed — the two reads are consistent.
 *
 * (2) **The unidentified fifth sub-field of the binary's `autoMode` shape.**
 * Read verbatim at `2.1.233` (the `classifyAllShell` member re-measured at the
 * vendored `2.1.247` on 2026-09-12 at 5 lines / 5 occurrences, C3.252), the object literal is
 * `be({allow:…,soft_deny:…,hard_deny:…,...!1,...{},environment:…,classifyAllShell:…})`.
 * There are five NAMED sub-fields — the four this module writes plus
 * `classifyAllShell` — and slots four and five are **two spreads a build gate
 * emptied**, `...!1` and `...{}`, which contribute nothing. The unidentified
 * field was a field the shipped build removes, not one we failed to read. It
 * stays worth re-reading on a bump: a gate flipped to `!0` would make one of
 * them a real sub-field, and the shape below would then be incomplete.
 *
 * @see docs/superpowers/plans/2026-08-22-runtime-parity-closure.md — P3.94, P3.95,
 *      P3.123, P3.142, P3.188
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { NESTOR_GATEWAY_HOST } from '../auth/nestor.ts'
import {
  resolveAutoModeClassifyAllShell,
  resolveManagedPiPolicyFloor,
  type ManagedPiPolicyV1,
} from './pi-harness/managed-policy.ts'
import { i18n, setupI18n } from '../i18n/index.ts'
import { getClaudeSwitchModelsOnFlag, getUserWorkflowSettings } from '../config/storage.ts'
import { CLAUDE_BUNDLED_BATCH_SKILL_OVERRIDE } from '../config/skill-overrides.ts'
import { buildClaudeAutoContinueAtUsageLimitSettings } from './usage-limit-reset.ts'
import {
  resolveWorkflowSettings,
  workflowDisableEnvLayer,
  type ResolvedWorkflowSettings,
  type WorkflowSizeGuideline,
} from '../config/workflow-settings.ts'

/**
 * The literal the binary's schema documents for each of the four arrays:
 * *"Include the literal string `$defaults` to inherit the built-in rules at that
 * position."* It APPENDS rather than replaces, which is the whole reason our
 * rules can be additive instead of a fork of Anthropic's list.
 */
export const CLAUDE_AUTO_MODE_DEFAULTS_SPLICE = '$defaults'

/**
 * This organisation's source-control host, read from `git remote -v` on the
 * repository this application is developed and deployed from
 * (`ssh://git@gitlab.tcsbank.ru:7999/...`). No source constant exists for it —
 * recorded here with its provenance rather than invented.
 */
export const NESSY_SOURCE_HOST = 'gitlab.tcsbank.ru'

/**
 * This organisation's package registry and container mirror, read from the
 * checked-in `bunfig.toml` (`registry = "https://artifactory.tcsbank.ru/..."`)
 * and `.gitlab-ci.yml` (`NPM_CONFIG_REGISTRY`, `NODE_IMAGE`). A drift guard in
 * the test beside this file re-reads `bunfig.toml` rather than trusting this
 * line.
 */
export const NESSY_PACKAGE_REGISTRY_HOST = 'artifactory.tcsbank.ru'

/**
 * The gateway credential, as a person and a classifier both write it. The
 * resolved absolute path comes from `auth/dp/creds-store.ts` → `getCredsPath()`;
 * the `~` form is what belongs in a prose rule, and the test beside this file
 * asserts the two still agree.
 */
export const NESSY_DP_CREDS_DISPLAY_PATH = '~/.nessy/dp_auth_creds.json'

/**
 * The four prose-rule arrays, exactly as the binary's `autoMode` schema names
 * them — plus the fifth field, the band control, which is a BOOLEAN and not
 * prose.
 */
export interface ClaudeAutoModePolicyV1 {
  readonly allow?: readonly string[]
  readonly soft_deny?: readonly string[]
  readonly hard_deny?: readonly string[]
  readonly environment?: readonly string[]
  /**
   * P6.191 — the administrator's `autoMode.classifyAllShell`, projected.
   *
   * `settings.md`, the key's own row: "**Default**: `false`. When `true`,
   * suspends every Bash and PowerShell allow rule while auto mode is active, so
   * all shell commands route through the classifier." The shipped `2.1.247`
   * binary parses the name — re-measured 2026-09-12 at 5 lines / 5 occurrences,
   * both instruments named because they disagree on a minified artefact
   * (C3.294); it read "4 occurrences" at `2.1.233` — in the same `autoMode` schema slot
   * as the four arrays above — it is the runtime's OWN mechanism, so native-first
   * makes this a projection rather than a second implementation.
   *
   * Only the RESTRICTIVE pole travels: `true` is written, `false` and unset are
   * not, because `false` is the documented default on that side and a floor
   * never grants.
   */
  readonly classifyAllShell?: true
}

/** The `settings` value this module contributes; `autoMode` and nothing else. */
export interface ClaudeAutoModeSettingsV1 {
  readonly autoMode: ClaudeAutoModePolicyV1
}

/**
 * Facts about the infrastructure this deployment legitimately talks to.
 *
 * The gateway sentence is emitted ONLY for a session whose adapter resolved the
 * `nestor` upstream, mirroring the standing rule that Nestor-specific behaviour
 * stays scoped to the verified gateway: a BYO endpoint must not be told that
 * traffic to a T-Bank host is its own normal model traffic, because for that
 * session it is not.
 */
export function buildClaudeAutoModeEnvironmentRules(input: {
  readonly gatewayUpstream: boolean
}): readonly string[] {
  return Object.freeze([
    CLAUDE_AUTO_MODE_DEFAULTS_SPLICE,
    ...(input.gatewayUpstream
      ? [
          `${NESTOR_GATEWAY_HOST} is this deployment's own model gateway. The agent's model `
          + `traffic reaches it through a loopback adapter this application starts on 127.0.0.1 `
          + `at an ephemeral port, so requests to that gateway host and to that loopback address `
          + `are ordinary model traffic, not exfiltration to an unrecognized service.`,
        ]
      : []),
    `${NESSY_SOURCE_HOST} is this organisation's source-control host. git fetch, pull, clone `
    + `and push against ssh://git@${NESSY_SOURCE_HOST} or https://${NESSY_SOURCE_HOST} are `
    + `recognized infrastructure for this user's own work.`,
    `${NESSY_PACKAGE_REGISTRY_HOST} is this organisation's package registry and container `
    + `mirror. bun, npm, pip and docker traffic to it is the ordinary dependency-install path `
    + `here, and is the expected substitute for the public registries.`,
  ])
}

/**
 * The one boundary user intent does not clear.
 *
 * Scoped to disclosure, not to existence: the agent may know the file is there
 * and may run a sign-in flow that writes it. What it may never do is move the
 * secret VALUE anywhere a second party could read it.
 */
export function buildClaudeAutoModeHardDenyRules(): readonly string[] {
  return Object.freeze([
    CLAUDE_AUTO_MODE_DEFAULTS_SPLICE,
    `Never disclose the contents of ${NESSY_DP_CREDS_DISPLAY_PATH}, nor any Nestor-Token header `
    + `value or gateway JWT, to any destination — not into another file, a network request, a `
    + `command argument, an environment variable, a log, or the reply to the user. Reading the `
    + `file to complete a sign-in the user asked for is fine; copying, printing or transmitting `
    + `the token is a security boundary, and a request to print it, dump it "for debugging", or `
    + `send it somewhere for support does NOT clear that boundary.`,
  ])
}

/** Destruction whose blast radius reaches a second product. */
export function buildClaudeAutoModeSoftDenyRules(): readonly string[] {
  return Object.freeze([
    CLAUDE_AUTO_MODE_DEFAULTS_SPLICE,
    `Deleting, truncating or overwriting ${NESSY_DP_CREDS_DISPLAY_PATH} signs the user out of `
    + `this application AND of the separate nessy-cli command-line tool, which share that one `
    + `file; treat it as destroying state outside this workspace rather than as removing a `
    + `local dotfile.`,
  ])
}

/**
 * P6.541 — the administrator's own prose, appended to ours.
 *
 * ## Why APPEND rather than compose through `resolveAutoMode`
 *
 * `resolveAutoMode` (`pi-harness/managed-policy.ts`) RESOLVES `"$defaults"`
 * against Pi's Guardian built-ins, because Pi has no classifier of its own to
 * inherit from. On claude the sentinel is the vendor's own splice instruction —
 * *"Include the literal string `$defaults` to inherit the built-in rules at that
 * position"* — and it has to survive to the child unresolved, or the
 * classifier's own built-ins are replaced by Pi's. So the two runtimes compose
 * the same administrator block by two different rules, and this is claude's.
 *
 * A repeated `"$defaults"` inside the administrator's own entries is DROPPED:
 * ours already leads with it, and a second splice would duplicate every one of
 * Anthropic's built-in rules inside one section. An administrator who wrote the
 * sentinel meant "keep the built-ins", which is what they get.
 *
 * ORDER: ours first, the administrator's after. That is presentational rather
 * than a boundary — the same statement `ManagedPiPolicyV1.autoMode` makes about
 * the Pi side — because nothing in either section can remove an entry from the
 * other.
 */
function appendManagedAutoModeRules(
  ours: readonly string[],
  managed: readonly string[] | undefined,
): readonly string[] {
  if (!managed || managed.length === 0) return ours
  const extra = managed.filter(entry => entry !== CLAUDE_AUTO_MODE_DEFAULTS_SPLICE)
  if (extra.length === 0) return ours
  return Object.freeze([...ours, ...extra])
}

/**
 * The administrator's `autoMode` keys this runtime REFUSES, in page order.
 *
 * Exactly one today, and the null is the point: `allow` is the only set that
 * can WIDEN what the classifier permits, and this fork withholds it on every
 * runtime — `resolveAutoMode` drops a user-scope `allow` for the same reason
 * one layer down, and this module's header records the decision for our own.
 * An administrator who wrote it is entitled to know it did not apply, because
 * the failure mode is silent: their exception is simply absent and the
 * classifier keeps denying.
 *
 * A key present but EMPTY still counts — `"allow": []` is a statement about the
 * allow set, and answering it with silence is the same defect
 * `refusedUserAutoModeKeys` names one layer down.
 *
 * The SENTENCE lives in the locale files (`chat.managedPolicy.autoModeAllowWithheld`)
 * rather than here — P6.613 put it on the durable operator channel, which is
 * translated, and one sentence with two homes is one sentence that drifts.
 */
export function refusedClaudeManagedAutoModeKeys(
  managedAutoMode: ManagedPiPolicyV1['autoMode'] | undefined =
    resolveManagedPiPolicyFloor()?.autoMode,
): readonly string[] {
  if (!managedAutoMode) return Object.freeze([])
  return Object.freeze(managedAutoMode.allow === undefined ? [] : ['allow'])
}

/**
 * The `autoMode` block for this session, or `undefined` when there is nothing
 * deployment-specific to say.
 *
 * NOT conditional on the permission mode. The block CONFIGURES the classifier
 * rather than enabling it, and it is inert in every mode where the classifier
 * does not run — while the permission mode can change mid-session through a
 * setter with no respawn, so a mode-conditional spawn argument would go stale
 * the moment a user switched into auto mode. Sending it always is both simpler
 * and the only shape that survives the switch.
 */
export function buildClaudeAutoModePolicySettings(input: {
  readonly gatewayUpstream: boolean
  /**
   * P6.191 — the administrator's own `autoMode` block, for the ONE sub-field
   * that has a slot on this runtime.
   *
   * Defaulted from {@link resolveManagedPiPolicyFloor} rather than taken from
   * the caller, which is the same shape `buildClaudeManagedSettingsOptions`
   * already uses for the managed slice: the provider gates that dropped this
   * setting off Pi all live in `SessionManager`, and threading a value through
   * them is how it went missing. Passing it explicitly is for tests and for a
   * host that resolves the policy some other way.
   *
   * P6.541 — THREE of the four prose arrays are now taken from here as well.
   * `environment`, `hard_deny` and `soft_deny` are appended after ours; `allow`
   * stays withheld on every runtime because a floor never grants, and it is
   * refused BY NAME through {@link refusedClaudeManagedAutoModeKeys} rather
   * than dropped in silence.
   */
  readonly managedAutoMode?: ManagedPiPolicyV1['autoMode']
}): ClaudeAutoModeSettingsV1 {
  const managedAutoMode = input.managedAutoMode ?? resolveManagedPiPolicyFloor()?.autoMode
  return {
    autoMode: {
      environment: appendManagedAutoModeRules(
        buildClaudeAutoModeEnvironmentRules(input),
        managedAutoMode?.environment,
      ),
      hard_deny: appendManagedAutoModeRules(
        buildClaudeAutoModeHardDenyRules(),
        managedAutoMode?.hard_deny,
      ),
      soft_deny: appendManagedAutoModeRules(
        buildClaudeAutoModeSoftDenyRules(),
        managedAutoMode?.soft_deny,
      ),
      // `allow` is deliberately omitted — see this file's header.
      //
      // `resolveAutoModeClassifyAllShell` is the SHARED resolver Pi's own band
      // reads, so the two runtimes cannot answer this question differently.
      // Scoped to `managed` alone here on purpose: we pass
      // `settingSources` with `user` (F1.768 gates only project/local), so a user's own
      // `autoMode.classifyAllShell` is already read natively by the child, and
      // re-projecting it would let the host's copy outlive a user's edit.
      ...(managedAutoMode && resolveAutoModeClassifyAllShell({ managed: managedAutoMode })
        ? { classifyAllShell: true as const }
        : {}),
    },
  }
}

/**
 * P6.583 — the vendor's own `feedbackDrafts` switch, set to `"off"`.
 *
 * `feedbackDrafts` decides what the claude runtime does with model-drafted
 * feedback (its `SendFeedback` tool). Its vendored default is `"notify"`, so
 * every claude session in this fork has been queuing drafts and printing a
 * one-line notice for them — a default nobody here chose, at a tier we set
 * nothing on. Owner decision 2026-09-05 (D13's posture, telemetry-shaped): set
 * the vendor's own switch OFF. A per-operator control can be exposed later; a
 * constant is what the decision actually says, and it is less code.
 *
 * The key is real on this runtime, not inferred: `sdk.d.ts` declares
 * `feedbackDrafts?: 'notify' | 'quiet' | 'off'` and documents the chosen value
 * verbatim — *"'off' disables the tool entirely so drafts are never queued"*.
 * Counted with `grep -ao <name> <file> | wc -l` (OCCURRENCES on a minified
 * artefact, not matching lines), against this repo's standing control
 * `nessyNotARealSdkKey` → 0 everywhere: 22 occurrences in the shipped
 * `2.1.233` native binary when this note was written, and **26 in the native
 * binary, 2 in `sdk.mjs`, 1 in `sdk.d.ts`** re-measured 2026-09-12 at the
 * vendored `0.3.247` / `2.1.247` (the line number this paragraph used to name is
 * dropped rather than renumbered — it had already moved).
 *
 * **It rides the FLAG tier and not the managed tier, and that is a measurement
 * rather than a preference.** The row proposing it said "the managed tier we
 * already write". The SDK's restrictive managed-settings filter, re-extracted
 * from that same binary by the anchor method in
 * `claude-managed-settings.ts`'s header (`allowManagedHooksOnly===!0`), copies
 * about twenty keys and `feedbackDrafts` is NOT one of them — so a managed
 * projection would have been a SILENT DROP, the exact failure that module exists
 * to prevent. `Options.settings` applies unconditionally, which is why P3.147's
 * credential floor and P3.94's `autoMode` block already live on this seam.
 *
 * **C3.257 — that paragraph SURVIVES the `0.3.247` bundle, and the reason it
 * READ as refuted is the thing worth writing down: the binary carries TWO
 * restrictive mechanisms and only one of them governs this question.** W15-b
 * found `{path:["feedbackDrafts"],restrictive:"off"}` in the shipped binary as a
 * failed negative control and took it for the filter named above. It is not that
 * filter. Re-measured 2026-09-12 at the vendored `0.3.247` / `2.1.247`, located
 * with `grep -aob <anchor>` and then read whole from the bytes around each hit —
 * and `sdk.mjs` carries BOTH mechanisms (1 occurrence each of
 * `allowManagedHooksOnly===!0` and of `{path:["feedbackDrafts"],restrictive:"off"}`,
 * `grep -aoF … | wc -l`), so the reading is reproducible on a text artefact and
 * needs no `strings` pass over the 233 MB binary:
 *
 *  - the FILTER is a two-argument function whose first line is
 *    `if(e.allowManagedHooksOnly===!0)`, and the call site applies it to OUR
 *    `Options.managedSettings` slice. Read end to end at `2.1.247`,
 *    `feedbackDrafts` does not occur in it; its only two members gained since
 *    `2.1.233` are `syncClaudeAiSkills===!1` and `syncClaudeAiPlugins===!1`,
 *    which is what `claude-managed-settings.ts`'s header already records.
 *  - the `{path:[…],restrictive:…}` TABLE that does carry `feedbackDrafts` is a
 *    different mechanism, with exactly two consumers in that module and neither
 *    of them ours: a sandbox-only extractor that keeps `path[0]==="sandbox"`
 *    entries and returns their `sandbox` subtree, and the ADMIN-TIER merge that
 *    folds remote + MDM + file into ONE admin document by taking, per key, the
 *    value earliest in that key's restrictive list. Our slice is the parent tier
 *    the filter is applied to AFTER that merge, so it never passes through the
 *    table.
 *
 * So the verdict stands and the flag tier remains the only seam that carries
 * this key; what this paragraph adds is WHICH table the claim is about, so the
 * next reader cannot refute it with the other one.
 */
export const CLAUDE_FEEDBACK_DRAFTS_SETTING: Readonly<{ feedbackDrafts: 'off' }> =
  Object.freeze({ feedbackDrafts: 'off' })

/**
 * **The single seam onto `Options.settings`, and the reason it exists.**
 *
 * `Options.settings` is ONE option, and it already had a contributor: P3.147's
 * credential-floor mirror (`claude-denied-path-rules.ts` →
 * `{ settings: { permissions: { deny } } }`). Spreading a second
 * `{ settings: … }` into the options literal after it would not merge — it would
 * REPLACE, silently deleting the credential floor from the spawn. That failure
 * leaves no error and no log line; it is the exact shape this plan has been bitten
 * by repeatedly. So both contributors come through here, and the options literal
 * spreads this and nothing else.
 *
 * Returned as a spreadable partial. It used to be absent when both contributors
 * were empty, so a spawn with nothing to say was byte-identical to one built
 * without this module; P6.583 retired that promise deliberately, because
 * {@link CLAUDE_FEEDBACK_DRAFTS_SETTING} is a posture rather than a per-session
 * fact and there is no session it should be absent from.
 */
export function buildClaudeFlagSettingsOptions(input: {
  readonly deniedPathSettings?: { readonly permissions: { readonly deny: string[] } } | undefined
  readonly autoModeSettings?: ClaudeAutoModeSettingsV1 | undefined
  /**
   * P6.319 — the host's resolved workflow settings. Defaulted from the same
   * three layers `SessionManager` composes, for the reason `managedAutoMode`
   * above is defaulted: threading a value through `claude-agent.ts` is how the
   * other three keys went missing in the first place.
   */
  readonly workflowSettings?: ResolvedWorkflowSettings
  /**
   * P6.370 — the user's model-switch answer, already resolved against the live
   * connection by {@link buildClaudeSwitchModelsOnFlagSettings}. Computed at the
   * call site like `deniedPathSettings` and `autoModeSettings` above, and for
   * the same reason: whether the session talks to Anthropic DIRECTLY is a fact
   * about the connection (`claude-agent.ts` sets `claudeRuntimeUpstreamKind`
   * only on the `claude-runtime` loopback path, so `null` IS the direct case)
   * and this module has no view of it.
   *
   * ABSENT means nothing travels, which is today's behaviour and the safe
   * direction — but it also makes a missing call site silent, so
   * {@link claudeSwitchModelsInertNotice} is what a user who set the key
   * actually meets.
   */
  readonly switchModelsSettings?: { switchModelsOnFlag?: false }
}): Pick<Options, 'settings'> {
  const merged = {
    ...CLAUDE_FEEDBACK_DRAFTS_SETTING,
    // C3.326 — the vendor's bundled `/batch`, off. A POSTURE rather than a
    // per-session fact, so it is defaulted here beside `feedbackDrafts` rather
    // than threaded through `claude-agent.ts`, for the reason this function's
    // own docblock gives. It rides the FLAG tier because that is where the SDK
    // puts `Options.settings` and because the tier MERGES per entry: measured
    // 2026-09-12 that a user's own `skillOverrides` entry survives beside this
    // one (a user-tier `doctor: 'off'` plus this flag-tier entry hid both, a
    // roster of 36 against 38 with neither). The whole measurement, the
    // alternatives refused and the residue are in
    // `config/skill-overrides.ts` (`CLAUDE_BUNDLED_BATCH_SKILL_NAME`).
    ...CLAUDE_BUNDLED_BATCH_SKILL_OVERRIDE,
    // P7.13 — the usage-limit resume-vs-stop answer, handed to the runtime's own
    // switch. Native-first step 1: `Settings.autoContinueAtUsageLimit` arrived at
    // the vendored `0.3.247` (18 occurrences in the native binary, 0 at
    // `0.3.233`), so this is configuration and nothing is built beside it — the
    // host's `awaitUsageLimitReset` gains no claude caller. It rides the FLAG
    // tier for the reason `feedbackDrafts` above does: the restrictive managed
    // filter does not copy it (`{path:["autoContinueAtUsageLimit"],restrictive:!1}`
    // is its own table entry, i.e. its restrictive pole is `false`), so a managed
    // projection would be a silent drop. Defaulted from the environment here
    // rather than threaded through `claude-agent.ts`, like `workflowSettings`.
    ...buildClaudeAutoContinueAtUsageLimitSettings(),
    ...buildClaudeWorkflowSettings(input.workflowSettings ?? resolveHostWorkflowSettings()),
    ...(input.switchModelsSettings ?? {}),
    ...(input.deniedPathSettings ?? {}),
    ...(input.autoModeSettings ?? {}),
  }
  return { settings: merged as NonNullable<Options['settings']> }
}

/** The three layers `SessionManager` composes, read the same way here. */
function resolveHostWorkflowSettings(): ResolvedWorkflowSettings {
  return resolveWorkflowSettings([
    getUserWorkflowSettings(),
    resolveManagedPiPolicyFloor()?.workflow ?? {},
    workflowDisableEnvLayer(),
  ])
}

/**
 * P6.319 — the workflow keys the vendored SDK declares and we passed none of,
 * projected onto the flag tier; C3.116 (QH9, owner answer B) turned the
 * PERMISSIVE direction on.
 *
 * Native-first, step 1: `sdk.d.ts` declares `enableWorkflows`,
 * `disableWorkflows`, `workflowSizeGuideline` and `workflowKeywordTriggerEnabled`
 * on `Settings`, with our exact 5/15/50 thresholds. Nothing is re-implemented;
 * the host's already-resolved answer is handed to the runtime's own switches.
 * `__tests__/claude-workflow-engine-reachability.test.ts` reads those four
 * declarations out of the vendored bundle rather than restating them, so a
 * rename is loud (the line numbers this docblock used to cite were re-derived
 * for C3.116 and dropped in favour of the declaration names, which do not decay).
 *
 * ## `enableWorkflows` travels in BOTH directions, because UNSET was never "off"
 *
 * Owner answer QH9 = B (2026-09-11): enable the SDK's own workflow engine on
 * claude. C3.115 measured what "unset" actually means first, on the vendored
 * `2.1.247`, and it is not what this function assumed. The binary's gate reduces
 * to `settings.enableWorkflows ?? defaultOn`, and `defaultOn` is `we()!=="pro"`
 * — the OAuth subscription type, which is `null` on any session not signed in to
 * Anthropic. So the answer the child reached depended on the USER'S ANTHROPIC
 * PLAN: measured ON for the gateway card with nothing sent at all (`Workflow` on
 * the init roster, and an `enableWorkflows: true` arm produced a byte-identical
 * roster), and off for a direct Anthropic **Pro** subscriber — while Pi's engine
 * is on for everyone. A plan-dependent divergence, not an absent engine.
 *
 * That is what the owner's answer closes, and it closes the same way P7.13
 * closed `autoContinueAtUsageLimit` one contributor above: a definite answer
 * travels on every spawn, so what this host promises and what the child does
 * agree by construction rather than through a default this host cannot observe.
 * It is NOT the `workflowSizeGuideline` case below — no vendor control is
 * seized, because the `/config` row the guideline explicitly hides has no
 * counterpart on this key.
 *
 * **The off switches are the vendor's own and still win — measured, not
 * assumed.** `disableWorkflows` is checked BEFORE the permissive key, so an
 * organisation's or a user's off beats this `true` from every tier: the user's
 * own `~/.claude/settings.json`, a project `.claude/settings.json`, this same
 * flag object, and `CLAUDE_CODE_DISABLE_WORKFLOWS` in the environment — four
 * arms, all measured absent. The restrictive managed-settings filter carries
 * `{path:["disableWorkflows"],restrictive:!0}`, which is why the org-wide switch
 * needs nothing built beside it here.
 *
 * **The one control this DOES take, stated because it is invisible otherwise.**
 * `Options.settings` is the flag tier, above user/project/local, so a user who
 * wrote `enableWorkflows: false` in their OWN `~/.claude/settings.json` is now
 * overridden — measured both ways: with this key sent the tool is on the roster,
 * with nothing sent it is absent. Two controls still express that intent and
 * both beat this one: `disableWorkflows` at any tier, and this product's own
 * workflow row, which is what resolves into the `settings` argument here.
 *
 * **Only what the host actually decided travels for the GUIDELINE, and that is
 * the whole design of the key below.**
 * The SDK's own doc for the guideline says a value here "including from managed
 * settings — takes precedence over the 'Dynamic workflow size' choice in
 * /config, and that /config row is hidden while a settings file provides the
 * key". So sending our value unconditionally would seize a user-facing control
 * on the strength of a default nobody chose.
 *
 * **And the defaults DIVERGE — stated here rather than silently kept.** Ours is
 * `unrestricted` ({@link WORKFLOW_SETTINGS_DEFAULTS}); the vendor's, documented
 * on that same declaration, is `medium`. This fork keeps `unrestricted` as its
 * own default deliberately — `workflowSizeGuidanceText` already treats it as
 * "nothing to say", so it costs zero prompt bytes and cannot re-stamp a cached
 * system prefix — and the consequence is that an unset host leaves the claude
 * child on the vendor's `medium`, which is a DIFFERENT answer from the one Pi
 * gets. That residue is real, it is the cost of not seizing the /config row, and
 * it disappears the moment any layer sets the key.
 *
 * `workflowKeywordTriggerEnabled` still travels in its RESTRICTIVE direction
 * only, matching the tighter-wins resolution the host applies to it: an off is a
 * decision, an on is our default and the vendor's too (`Default: true` on that
 * declaration). It is the one key of the three where the two defaults AGREE, so
 * sending our `true` would be a change dressed as a no-op.
 */
export function buildClaudeWorkflowSettings(settings: ResolvedWorkflowSettings): {
  enableWorkflows: boolean
  workflowSizeGuideline?: WorkflowSizeGuideline
  workflowKeywordTriggerEnabled?: false
} {
  return {
    // Both directions: `false` is the host's off, `true` is the host's on, and
    // the vendor's unset is neither (see the docblock — it is the user's plan).
    enableWorkflows: !settings.disableWorkflows,
    ...(settings.sizeGuideline === 'unrestricted' ? {} : { workflowSizeGuideline: settings.sizeGuideline }),
    ...(settings.keywordTriggerEnabled ? {} : { workflowKeywordTriggerEnabled: false as const }),
  }
}

/**
 * P6.370 — the control P6.319 said had to be added first, added, and projected
 * exactly where P6.319's own record said the projection belongs: beside
 * {@link buildClaudeWorkflowSettings}.
 *
 * ## What the vendor does without us
 *
 * `switchModelsOnFlag` is native and defaults ON — re-measured 2026-09-12 at
 * 7 lines / 13 occurrences in the vendored `2.1.247` binary (it read "23
 * occurrences" at `2.1.233` with no instrument named; C3.252/C3.294). When
 * Anthropic's safety classifier flags a turn,
 * the child re-runs it on a DIFFERENT model, and until this row the user had no
 * say. Native-first step 1 is therefore *the runtime already has the mechanism*,
 * and this is step 1's own answer: configure the vendor's key, build nothing
 * beside it.
 *
 * ## `Options.settings`, NOT `managedSettings` — measured, not chosen
 *
 * The obvious home is the managed tier, and it would have been a SILENT NO-OP,
 * the exact P6.688 shape. The SDK's restrictive managed-settings filter (the
 * function after `parentSettingsBehavior==="merge"` in the vendored `sdk.mjs`)
 * copies about twenty keys and `switchModelsOnFlag` is not one of them: probed
 * over the filter body it scores **0**, against `permissions` 5 and
 * `allowManagedHooksOnly` 2 as positive controls on the same read (counts over a
 * SLICE of the file, so neither instrument's whole-file figure applies —
 * over the whole binary those two are 330/646 and 20/34; C3.294, and a count of
 * ZERO is the one reading no instrument can change, which is what this claim
 * rests on), and the key
 * occurs exactly **once** in the whole of `sdk.mjs` — its type declaration.
 * `Options.settings` applies unconditionally, which is why P3.147's credential
 * floor and P3.94's `autoMode` block already live on this seam.
 * `__tests__/claude-auto-mode-policy.test.ts` reads that filter out of the
 * bundle rather than restating it, so the day the SDK adds the key this goes
 * red instead of leaving the row closed on a stale reading.
 *
 * ## Three states, and only one of them travels
 *
 * UNSET projects NOTHING. An install that never touched the key must spawn
 * byte-identically to one built before this row, and the vendor's own default is
 * ON, so emitting `true` would be a change dressed as a no-op. An explicit
 * `true` is likewise silent for the same reason. Only an explicit `false`
 * travels — the same restrictive-direction-only rule
 * {@link buildClaudeWorkflowSettings} applies to its two booleans, for the same
 * reason: an off is a decision, an on is our default.
 *
 * ## Where it binds, and where it is inert
 *
 * It binds on a DIRECT-Anthropic connection only, because that is the only
 * deployment where the classifier that raises the flag runs at all. A
 * `claude-runtime` connection — the Nessy Gateway card and every BYO endpoint —
 * reaches its endpoint through our loopback adapter, which runs no such
 * classifier, so there is nothing to flag and the key would decide nothing.
 * Pi and codex never see the key. A user who set it and got a session where it
 * cannot bind is TOLD, by {@link claudeSwitchModelsInertNotice} — silence there
 * would be a control that looks applied and is not, which is the defect class
 * this whole seam exists to remove.
 */
export function buildClaudeSwitchModelsOnFlagSettings(input: {
  readonly directAnthropic: boolean
  /** Defaulted from `config.json` for the reason `workflowSettings` above is. */
  readonly configured?: boolean | undefined
}): { switchModelsOnFlag?: false } {
  const configured = input.configured === undefined ? getClaudeSwitchModelsOnFlag() : input.configured
  return configured === false && input.directAnthropic ? { switchModelsOnFlag: false as const } : {}
}

/**
 * The sentence for a user who turned the model switch off on a connection where
 * it cannot bind. `undefined` on every other session, including the whole
 * unconfigured world, so nothing new is said to anyone who did not ask.
 *
 * Resolved here rather than at the spawn site so the locale key has a reader in
 * this package and the two halves cannot drift apart.
 */
export function claudeSwitchModelsInertNotice(input: {
  readonly directAnthropic: boolean
  readonly configured?: boolean | undefined
}): string | undefined {
  const configured = input.configured === undefined ? getClaudeSwitchModelsOnFlag() : input.configured
  if (configured !== false || input.directAnthropic) return undefined
  if (!i18n.isInitialized) setupI18n()
  return i18n.t('chat.claudeModelSwitch.inertOnThisConnection')
}

/**
 * P6.319, the other key the row named — and the honest verdict is that it is
 * not a DROP.
 *
 * `fastModePerSessionOptIn` (`sdk.d.ts:7222`) is declared on the same
 * `Settings` interface as the three above, so the seam could carry it. What is
 * missing is the other end: this fork has no host control for it — measured
 * 2026-09-06, `git grep -ail` over `packages` and `apps` found the name in
 * exactly ONE file, THIS one, so outside this record there is no reader at all;
 * the controls on the same run are `disableWorkflows` 25, `ultracode` 20 and
 * `fastMode` 19. A drop needs an input to drop; there is none.
 *
 * So this is an ABSENT host control, not a silent subtraction, and it is named
 * here rather than left to be rediscovered. Adding it means adding a setting
 * first, and the projection is then one line beside
 * {@link buildClaudeWorkflowSettings} — which is exactly the route P6.370 took
 * for its twin, `switchModelsOnFlag`, now removed from this list because it HAS
 * a host control. It is NOT projected as a constant: it is a user-facing
 * session posture (whether fast mode survives a restart), and choosing one on
 * the user's behalf at the tier that hides their own control is the seizure the
 * guideline above refuses.
 */
export const CLAUDE_WORKFLOW_KEYS_WITHOUT_A_HOST_CONTROL: readonly string[] =
  Object.freeze(['fastModePerSessionOptIn'])
