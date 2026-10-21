/**
 * The security approval dialog —
 * `server-managed-settings.md#security-approval-dialogs`.
 *
 * "Certain settings that could pose security risks require explicit user
 * approval before Claude Code applies them in an interactive session".
 * "When these settings are present, users see a security dialog explaining what
 * is being configured. Users must approve to proceed. If a user rejects the
 * settings, Claude Code exits."
 *
 * ## The bullet list MOVES — read it by NAME, never by number
 *
 * This file once cited the bullets by their line numbers on the page and named
 * four categories. Re-read 2026-08-28: the section listed five, with the new one
 * inserted SECOND, so every later citation had silently slid one bullet down.
 * Re-read 2026-09-11 (P6.1038): five again, and a DIFFERENT five — one bullet
 * inserted THIRD, one bullet gone. Every line-numbered anchor into this section
 * has therefore been wrong twice in a fortnight, which is why the section
 * comments below name the bullet instead of pointing at it. The bullets today,
 * by name and verbatim:
 *
 * 1. "**Shell command settings**: settings that execute shell commands, such as
 *    `apiKeyHelper`, `statusLine`, and `otelHeadersHelper`"
 * 2. "**Sandbox binary settings**: `sandbox.bwrapPath`, `sandbox.socatPath`, and
 *    `sandbox.ripgrep`. Each of these settings points at an executable, and
 *    Claude Code runs that executable"
 * 3. "**Sandbox network and isolation settings**: sandbox settings that let the
 *    sandbox proxy read, reroute, or authenticate traffic, or that weaken the
 *    sandbox's isolation: `sandbox.network.tlsTerminate`,
 *    `sandbox.network.httpProxyPort`, `sandbox.network.socksProxyPort`,
 *    `sandbox.credentials`, `sandbox.allowAppleEvents`,
 *    `sandbox.enableWeakerNestedSandbox`,
 *    `sandbox.enableWeakerNetworkIsolation`, `sandbox.filesystem.disabled`,
 *    `sandbox.network.allowAllUnixSockets`, `sandbox.network.allowUnixSockets`,
 *    and `sandbox.network.allowMachLookup`. A `sandbox.credentials` block that
 *    contains only `deny` rules doesn't need approval, since it restricts the
 *    sandbox without giving the proxy a credential. Before v2.1.251, Claude
 *    Code applied these settings without approval" — NEW since the 2026-08-28
 *    read, and the eleven keys are quoted here rather than counted because the
 *    only way to know which of them we carry is to try each one (the section
 *    below did, key by key).
 * 4. "**Custom environment variables**: delivered `env` variables that require
 *    the user's approval, such as proxy and base-URL variables"
 * 5. "**Hook configurations**: any hook definition"
 *
 * ## `claudeMd` LEFT the list at v2.1.260, and the class left at F1.255's lift
 *
 * The bullet the 2026-08-28 read recorded fifth — "**Managed CLAUDE.md
 * content**: a `claudeMd` value delivered through managed settings" — is no
 * longer a bullet. The page now says the opposite, in a paragraph below the
 * list: "A managed CLAUDE.md delivered through the `claudeMd` key doesn't
 * require approval, because it's instruction text for Claude rather than a
 * command Claude Code runs. Claude Code still checks permissions for the tools
 * Claude uses while following those instructions. Before v2.1.260, a `claudeMd`
 * value required approval too."
 *
 * {@link ManagedApprovalCategoryV1}'s `instruction` member encoded the
 * pre-2.1.260 rule and STAYED, for three reasons dated 2026-09-11:
 *  - the vendored bundle was below the reversal, both self-reports agreeing at
 *    `2.1.247` (later `2.1.251`). F1.255 (2026-09-24) lifted it to `2.1.267` —
 *    `"claudeCodeVersion": "2.1.267"` and `2.1.267 (Claude Code)` — past both
 *    2.1.251 and 2.1.260, so the member was FLIPPED OUT as the paragraph below
 *    instructs, and the shipped runtime no longer prompts for `claudeMd`.
 *  - the harm direction is the safe one: we would prompt where Claude Code no
 *    longer does — never apply where it would still ask.
 *  - and nothing can reach the class today in any case: `claudeMd` has no
 *    carrier in {@link ManagedPiPolicyV1}, so the tolerant parser strips it (the
 *    salvaged-payload rule below). The member is a NAME held against the day a
 *    carrier is added, not a live arm.
 * FLIP IT AT THE LIFT THAT REACHES 2.1.260 OR LATER — DONE at F1.255: from
 * that bundle on, a carrier added for `claudeMd` must NOT be classified, and the
 * member went with the rule it encoded. (Deleting it while the shipped binary
 * was older would have been building to a contract we did not run.)
 *
 * ## Bullet 2 is provably empty for us; bullet 3 is NOT
 *
 * The sandbox BINARY bullet strips by the same MECHANISM two of the others do:
 * `sandbox.bwrapPath`, `sandbox.socatPath` and `sandbox.ripgrep` have no
 * counterpart in {@link ManagedPiPolicyV1} — `managed-composition.ts` records
 * the same absence for the first two — so a delivered value is an unknown key
 * the tolerant parser strips. Its EMPTINESS is a different kind, though, and
 * §"Two kinds of emptiness" below says which: nothing here is waiting for a
 * carrier that is coming.
 *
 * The NEW sandbox network/isolation bullet does not inherit that argument. Ten
 * of its eleven keys sit in `sandbox-settings.ts`'s
 * `DOCUMENTED_UNCARRIED_SANDBOX_KEYS` and are stripped the same way —
 * re-measured 2026-09-11 (P6.1046) one key at a time, each delivered alone: the
 * ten parse away to `{}` or `{"network":{}}`, and only
 * `sandbox.filesystem.disabled` survives, to `{"filesystem":{"disabled":true}}`.
 * It is a real carrier — `SandboxFilesystemSettingsV1.disabled` in
 * `config/sandbox-settings.ts`, not linked here because the type is not imported
 * into this module — and its own docblock states the price: "**This surrenders the settings-file write
 * protection**" — `sandboxing.md#protected-paths`, "The only way to turn the
 * protection off is `filesystem.disabled`, which turns off filesystem isolation
 * for every path."
 *
 * P6.1038 measured it unclassified and reported it; P6.1046 gives it the
 * `sandbox` category below. Three reasons, and the third is why this is a floor
 * rather than a stopgap:
 *  - the harm direction is the UNSAFE one, the opposite of `claudeMd`'s: we
 *    would APPLY where the documented runtime (v2.1.251 or later) asks.
 *  - the vendored bundle self-reports 2.1.247 twice over — `claudeCodeVersion`
 *    in the SDK manifest and the native binary's own `--version`, both read
 *    2026-09-11 — which is below 2.1.251, so nothing prompts for this key
 *    anywhere today. The dialog added here is the first one.
 *  - and the claude child could not prompt for it even after the lift, because
 *    it never receives it: `true` is the WIDENING pole, `mapSandbox`
 *    (`agent/claude-managed-settings.ts`) sends only the locking pole
 *    (`sandbox.filesystem.disabled === false`), and `CLAUDE_WITHHELD_SUB_KEYS`
 *    pins the withholding. What a delivered `true` DOES reach is this host's own
 *    isolation funnel — `server-core/src/pi-harness/isolation.ts`, and
 *    `filesystemIsolationDisabled` on every supervised process — so the host's
 *    dialog is the only dialog this key will ever have.
 *
 * ## Two kinds of emptiness, and only one of them is waiting for a carrier
 *
 * A NAME HELD AGAINST A FUTURE CARRIER — `hook` is a real member of
 * {@link ManagedApprovalCategoryV1} with nothing to classify yet, because
 * `hooks` has no counterpart in {@link ManagedPiPolicyV1} (the shape
 * `0c7acdfbe` shipped), so the day it gains one the member is here to receive
 * it. (`instruction` was the second such name until F1.255 flipped it out.)
 *
 * A STANDING REFUSAL — the sandbox-binary bullet's `sandbox.bwrapPath`,
 * `sandbox.socatPath` and `sandbox.ripgrep` are all three in
 * `sandbox-settings.ts`'s `DOCUMENTED_UNCARRIED_SANDBOX_KEYS`, whose own rule is
 * "Add a name here only to record a DECIDED refusal", so while the sandbox
 * posture stands no carrier is coming, there is no category to hold open, and
 * {@link ManagedApprovalCategoryV1} correctly has no member for them — its
 * `sandbox` member is bullet 3's carrier, not bullet 2's.
 *
 * ## Two rules that are easy to get backwards
 *
 * `#invalid-entries-in-delivered-settings` — the dialog evaluates the SALVAGED
 * payload, "so a stripped invalid entry is never presented for approval and
 * never executes". This module
 * therefore takes a parsed {@link ManagedPiPolicyV1}, never a raw document.
 * That is also why all three of the emptinesses above are empty today rather
 * than merely unimplemented: we carry no managed hook definitions, no managed
 * instruction-file key and no sandbox binary paths, so a delivered `hooks`,
 * `claudeMd` or `sandbox.bwrapPath` block is an unknown key that the tolerant
 * parser strips — which is exactly the salvaged-payload rule's outcome, not a
 * gap. `managed-approval.test.ts` pins that stripping for `hooks` and
 * `claudeMd`, so adding either key to the schema without classifying it fails.
 *
 * `#approval-memory`'s two cases — an interactive session that CANNOT show the
 * dialog does not apply the delivered settings and keeps the last approved
 * ones, with the dialog appearing in the next session that can. A
 * NON-interactive run (`-p`,
 * an SDK session, our headless server and CLI) applies them for that run only:
 * no approval recorded, no cache write, and it re-fetches every run until a
 * user approves interactively. Collapsing the two would either strand a
 * headless fleet or silently record an approval no human gave.
 */

import { createHash } from 'node:crypto'
import type { ManagedPiPolicyV1 } from '../agent/pi-harness/managed-policy.ts'
import { classifyManagedEnvVar } from './managed-env.ts'

export type ManagedApprovalCategoryV1 =
  /** "Shell command settings": settings that execute shell commands. */
  | 'shell'
  /** "Custom environment variables": delivered `env` variables needing approval. */
  | 'env'
  /** "Hook configurations": any hook definition. */
  | 'hook'
  /**
   * "Sandbox network and isolation settings" — the one key of that bullet with
   * a carrier here, `sandbox.filesystem.disabled`. The other ten strip, and
   * this one is withheld from the claude child, so this category is the only
   * place a human is ever asked about it. See the header.
   */
  | 'sandbox'
  // `instruction` (a `claudeMd` value) LEFT at F1.255's lift to 2.1.267: the
  // page dropped that bullet at v2.1.260 and the shipped bundle is now past it,
  // so a carrier added for `claudeMd` must NOT be classified — see the header.
  // Nothing classified to it (no carrier), so no dialog reading moves; five
  // lines kept on purpose, because this file is cited by line.

export interface ManagedApprovalItemV1 {
  readonly category: ManagedApprovalCategoryV1
  /** Dotted policy path, e.g. `sandbox.excludedCommands`. */
  readonly field: string
  /**
   * What the user is being asked to accept. Names and counts only — a dialog
   * that rendered a delivered value would put a token on screen and into any
   * screenshot of it.
   */
  readonly detail: string
}

export interface ManagedApprovalRequestV1 {
  readonly items: readonly ManagedApprovalItemV1[]
  /** Identity of the exact payload being approved. */
  readonly digest: string
}

/**
 * Environment variables an organization may set without a prompt.
 *
 * Deliberately short, and the shape is OURS. This comment said the page "asks
 * for a `known safe allowlist`" — **that phrase occurs nowhere on the page**
 * (re-read 2026-08-28; the same false quote sat in `managed-env.ts`).
 * `#environment-variables-and-the-approval-dialog` is framed the other way
 * round, as a SKIP list: "Claude Code applies some delivered `env` variables
 * without showing the user the approval dialog, including:" — feature and
 * command toggles, model selection, context-window settings, terminal UI,
 * numeric limits — and then "Other delivered variables can require the user's
 * approval before they take effect; a non-empty proxy, base-URL, or
 * `OTEL_EXPORTER_OTLP_ENDPOINT` value always does."
 *
 * So this set is an allowlist we chose, not one the page names, and safe here
 * means the variable cannot redirect a request, authenticate as anybody, change
 * what code runs, or carry a secret.
 *
 * ## P3.210 — the endpoint LEFT this set, and the divergence is closed
 *
 * The paragraph above used to end: "Note the page ALWAYS requires a dialog for
 * `OTEL_EXPORTER_OTLP_ENDPOINT`, which is in this set — recorded as a divergence
 * rather than quietly resolved, because removing it is a behaviour change." The
 * owner decided the behaviour change (2026-09-02, §C3: *align with the page*),
 * so the name is gone. Re-read 2026-09-03,
 * `server-managed-settings.md#environment-variables-and-the-approval-dialog`
 * still says, verbatim: "Other delivered variables can require the user's
 * approval before they take effect; a non-empty proxy, base-URL, or
 * `OTEL_EXPORTER_OTLP_ENDPOINT` value always does."
 *
 * The direction of the old error is why it mattered: an endpoint variable is an
 * egress control and our allowlist was the LOOSER side, so an organisation could
 * redirect this client's telemetry with no human in the loop. The page grants a
 * dialog for a *non-empty* value; we prompt for any delivered value, including
 * an empty one. That is deliberately the stricter reading and it is one line of
 * behaviour rather than a value test — an empty endpoint is still an
 * administrator changing where telemetry goes, and "can require" leaves the
 * choice to us.
 *
 * ## `OTEL_EXPORTER_OTLP_HEADERS` left with it, and the page is silent
 *
 * Decided here rather than queued (`AGENTS.md`, *where the documentation is
 * silent: TRANSPARENT and SIMPLE*): the page names the endpoint and says nothing
 * about the headers, but this set's OWN criterion is three lines up — safe means
 * a variable that cannot "carry a secret" — and `OTEL_EXPORTER_OTLP_HEADERS` is
 * the standard place an OTLP deployment puts its `Authorization` header.
 * `managed-env.ts` already treats it as a credential carrier in as many words
 * (P3.63's telemetry-unit rule exists to stop a file-supplied credential pairing
 * with a delivered endpoint). Keeping it dialog-free while the endpoint needs
 * one would leave the credential half of the same unit ungated.
 *
 * `#fetch-and-caching-behavior`'s named remainder — "telemetry and
 * OpenTelemetry configuration" — is still the bulk of what remains, and those
 * three cannot redirect an export or authenticate anybody.
 *
 * Every WITHHELD variable is excluded by construction: `managed-approval.test.ts`
 * asserts the two sets are disjoint, so a variable can never be simultaneously
 * "too dangerous to apply before confirmation" and "safe enough to skip the
 * dialog".
 */
export const MANAGED_ENV_SAFE_ALLOWLIST: ReadonlySet<string> = Object.freeze(new Set([
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TIMEOUT',
  // `monitoring-usage.md#common-configuration-variables` — "Export interval in
  // milliseconds (default: 60000)".
  // A batching knob: it cannot redirect an export or carry a credential.
  'OTEL_METRIC_EXPORT_INTERVAL',
  // C3.291 — the TRACES half of the same knob, added 2026-09-12 and stated
  // rather than assumed, because widening a SAFE allowlist is a posture and not
  // a tidy-up. `monitoring-usage.md#traces-beta` gives it its own row: "Span
  // batch export interval in milliseconds (default: 5000)". It is in the same
  // class as its metrics sibling above by this set's OWN criterion — it can
  // neither redirect an export (that is the endpoint, which always raises the
  // dialog) nor carry a credential (that is `OTEL_EXPORTER_OTLP_HEADERS`, which
  // was deliberately left OUT for exactly that reason). The only thing an
  // administrator can do with it is change how often spans are flushed.
  //
  // Its reader is `resolveTraceExportIntervalMs` (`telemetry/host-tracer.ts`),
  // which already clamps a non-positive or unparseable value back to the
  // documented 5000 ms, so a hostile value cannot even stop the export.
  //
  // It was MISSING while the sibling was present (W16-d, PR-1), which is the
  // asymmetry this entry closes: an operator who set both got a dialog for one
  // of them and no stated reason for the difference.
  'OTEL_TRACES_EXPORT_INTERVAL',
]))

/** Stable identity of a salvaged payload, for the approval record. */
export function managedPayloadDigest(payload: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(payload)).digest('hex')}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
}

/**
 * Which delivered settings need a human before they take effect.
 *
 * Category 1 is read as "the delivered value causes a shell command to run
 * that otherwise would not, or to run less confined". That is the three places
 * this policy can do it: unlocking unsandboxed execution, naming commands
 * excluded from the sandbox, and an `allow` rule on a command matcher, which
 * removes the prompt that would otherwise stand between the model and a shell.
 * A `deny` or `ask` rule is not listed — those only ever subtract.
 */
export function classifyManagedApproval(
  policy: ManagedPiPolicyV1,
  digestOf: unknown = policy,
): ManagedApprovalRequestV1 | null {
  const items: ManagedApprovalItemV1[] = []

  // ---- "Shell command settings" -------------------------------------------
  if (policy.sandbox?.allowUnsandboxedCommands === true) {
    items.push(Object.freeze({
      category: 'shell' as const,
      field: 'sandbox.allowUnsandboxedCommands',
      detail: 'permits commands to run outside the sandbox',
    }))
  }
  const excluded = policy.sandbox?.excludedCommands ?? []
  if (excluded.length > 0) {
    items.push(Object.freeze({
      category: 'shell' as const,
      field: 'sandbox.excludedCommands',
      detail: `${excluded.length} command pattern(s) exempted from the sandbox`,
    }))
  }
  const allowRules = (policy.permissionDsl?.rules ?? []).filter(rule => (
    rule.action === 'allow'
    && (rule.match.kind === 'bash' || rule.match.kind === 'tool')
  ))
  if (allowRules.length > 0) {
    items.push(Object.freeze({
      category: 'shell' as const,
      field: 'permissionDsl.rules',
      detail: `${allowRules.length} rule(s) allow tool or command execution without a prompt`,
    }))
  }

  // ---- "Sandbox network and isolation settings" ---------------------------
  // Ten of that bullet's eleven keys have no carrier in this schema and the
  // tolerant parser strips them (measured key by key — see the header). This is
  // the eleventh, and `true` is its widening pole: `false` is an administrator
  // keeping filesystem isolation on, which subtracts and needs no human.
  if (policy.sandbox?.filesystem?.disabled === true) {
    items.push(Object.freeze({
      category: 'sandbox' as const,
      field: 'sandbox.filesystem.disabled',
      detail: 'turns filesystem isolation off for every path, surrendering the '
        + 'write protection on the files this app loads its own configuration and code from',
    }))
  }

  // ---- "Custom environment variables" -------------------------------------
  const custom = Object.keys(policy.env ?? {}).filter(name => !MANAGED_ENV_SAFE_ALLOWLIST.has(name)).sort()
  for (const name of custom) {
    items.push(Object.freeze({
      category: 'env' as const,
      field: `env.${name}`,
      // The CATEGORY is named, never the value. Naming the category is what
      // makes the prompt actionable: "this sets a credential" reads very
      // differently from "this sets a telemetry endpoint".
      detail: `sets ${name} (${classifyManagedEnvVar(name)})`,
    }))
  }

  // ---- "Hook configurations", and `claudeMd` while it still counted --------
  // Neither has a carrier in this schema, so a delivered `hooks` or `claudeMd`
  // block is an unknown key the tolerant parser strips —
  // `#invalid-entries-in-delivered-settings`'s "never presented for approval
  // and never executes", reached by the parser rather
  // than by this classifier. Pinned by test; adding either key to the schema
  // without extending this function fails it.

  if (items.length === 0) return null
  return Object.freeze({
    items: Object.freeze(items),
    digest: managedPayloadDigest(digestOf),
  })
}

/**
 * How much of a dialog this session can show.
 *
 * `#approval-memory` names both: "**An interactive session that can't show the
 * dialog**: Claude Code doesn't apply the delivered settings and keeps the
 * last-approved settings" is `interactive-unavailable`, and "**A
 * non-interactive run**, such as `claude -p` or an Agent SDK session … it
 * applies them for that run only" is `non-interactive`. They are different
 * states with different outcomes, so they are different values rather than one
 * boolean.
 *
 * No host passes `interactive-unavailable` today, and therefore nothing reaches
 * `outcome: 'deferred'`. That is a property of THIS host, not a dead arm:
 * Electron's `dialog.showMessageBox` needs no window, so the desktop shell can
 * always prompt, and the headless host is the non-interactive case. The value
 * stays because it is the exported way an embedder says "interactive, but I
 * cannot ask right now", which the first bullet requires to exist — collapsing it into
 * `non-interactive` would silently apply a payload the doc says to hold back.
 */
export type ManagedApprovalModeV1 =
  /** A session that can put a modal in front of a person. */
  | 'interactive'
  /** An interactive session that cannot show the dialog right now. */
  | 'interactive-unavailable'
  /** Headless server, CLI, SDK-style run — the non-interactive bullet. */
  | 'non-interactive'

export interface ManagedApprovalResolutionV1 {
  readonly outcome:
    | 'no-approval-needed'
    | 'already-approved'
    | 'approved'
    | 'rejected'
    | 'deferred'
    | 'run-only'
  /** Apply the delivered payload to this session. */
  readonly apply: boolean
  /** Write the salvaged payload to the cache. */
  readonly persist: boolean
  /** Stamp the payload digest as approved. */
  readonly approvedDigest?: string
  /** "If a user rejects the settings, Claude Code exits." */
  readonly exit: boolean
  readonly request?: ManagedApprovalRequestV1
}

export interface ResolveManagedApprovalOptions {
  policy: ManagedPiPolicyV1
  /** The salvaged payload as it will be cached; the digest is taken over it. */
  payload: unknown
  mode: ManagedApprovalModeV1
  /** Digest recorded against the cached payload, when there is one. */
  approvedDigest?: string | undefined
  /** Shows the dialog. Resolves `true` to approve, `false` to reject. */
  prompt?: (request: ManagedApprovalRequestV1) => Promise<boolean> | boolean
}

/**
 * Decide what happens to a delivered payload that may need approval.
 *
 * Every branch returns explicit `apply`/`persist`/`exit` rather than letting a
 * caller infer them, because the non-interactive combination — apply, but
 * neither record nor cache — is the one a caller would get wrong.
 */
export async function resolveManagedApproval(
  options: ResolveManagedApprovalOptions,
): Promise<ManagedApprovalResolutionV1> {
  const request = classifyManagedApproval(options.policy, options.payload)
  if (!request) {
    return Object.freeze({
      outcome: 'no-approval-needed' as const, apply: true, persist: true, exit: false,
    })
  }
  if (options.approvedDigest !== undefined && options.approvedDigest === request.digest) {
    return Object.freeze({
      outcome: 'already-approved' as const,
      apply: true,
      persist: true,
      approvedDigest: request.digest,
      exit: false,
      request,
    })
  }

  if (options.mode === 'non-interactive') {
    // Applies for that run only; no approval recorded, no cache write,
    // so the next run fetches again and an interactive session still prompts.
    return Object.freeze({
      outcome: 'run-only' as const, apply: true, persist: false, exit: false, request,
    })
  }

  if (options.mode === 'interactive-unavailable' || !options.prompt) {
    // Do not apply, keep the last-approved settings, prompt next time.
    return Object.freeze({
      outcome: 'deferred' as const, apply: false, persist: false, exit: false, request,
    })
  }

  const approved = await options.prompt(request)
  if (!approved) {
    // "If a user rejects the settings, Claude Code exits."
    return Object.freeze({
      outcome: 'rejected' as const, apply: false, persist: false, exit: true, request,
    })
  }
  return Object.freeze({
    outcome: 'approved' as const,
    apply: true,
    persist: true,
    approvedDigest: request.digest,
    exit: false,
    request,
  })
}

/** One line per item, for a native dialog body. Values never appear. */
export function renderManagedApprovalSummary(request: ManagedApprovalRequestV1): string {
  const label: Record<ManagedApprovalCategoryV1, string> = {
    shell: 'Shell execution',
    sandbox: 'Sandbox isolation',
    env: 'Environment variable',
    hook: 'Hook',
  }
  return request.items
    .map(item => `${label[item.category]}: ${item.field} — ${item.detail}`)
    .join('\n')
}
