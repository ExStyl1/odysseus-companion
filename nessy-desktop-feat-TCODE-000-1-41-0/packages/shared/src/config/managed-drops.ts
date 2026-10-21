/**
 * The diagnostics primitive every managed-settings parser shares.
 *
 * It lives in `config/` rather than beside the managed policy so that
 * `sandbox-settings.ts` — which the managed policy imports — can take a sink
 * without importing back from `agent/pi-harness/`. The public drop types are
 * re-exported from `agent/pi-harness/managed-policy.ts`, which is where callers
 * read them.
 *
 * `managed-settings.md#keys-that-fail-closed` is the reason this is a SINK
 * rather than a mode flag — "This tolerance applies only to managed settings."
 * Tolerance belongs to the managed call site, and a helper reached from the
 * user, project or local tier keeps {@link STRICT_DROP_SINK}, which throws.
 */

// The one import this primitive takes, and it is a string constant: the refusal
// note below must name the SAME managed instruction filename the loader reads,
// and a second hand-kept copy of that name is the drift this repo has paid for
// before. `managed-system-paths.ts` imports node builtins and nothing of ours
// (`grep -n '^import' packages/shared/src/config/managed-system-paths.ts` → two
// `node:` lines), so the property this file's header claims — no import back
// from `agent/pi-harness/` — holds.
import { MANAGED_INSTRUCTION_FILE } from './managed-system-paths';

/** What the tolerant parse did with an entry it could not accept. */
export type ManagedPolicyDropDispositionV1 =
  /** Removed. The policy behaves as though the entry had never been written. */
  | 'stripped'
  /** A grant list was enforced EMPTY, so it admits nothing until it is fixed. */
  | 'emptied'
  /** A security switch was read at its enforcing value. */
  | 'tightened'

/**
 * One entry the managed tier refused, in the shape the three documented
 * consumers need. `managed-settings.md#find-entries-claude-code-dropped` names
 * them as a three-bullet list — "Interactive sessions show a dialog at startup
 * listing the invalid entries.", "Non-interactive runs with `-p` print a summary
 * to stderr." and, of `claude doctor`, "lists each invalid entry with its source
 * and field." 
 */
export interface ManagedPolicyDropV1 {
  /** The file the entry came from. */
  readonly source: string
  /** Dotted/indexed path, e.g. `sandbox.network.allowedDomains[1]`. */
  readonly field: string
  /** Admin-facing explanation — the strict parser's own message. */
  readonly reason: string
  readonly disposition: ManagedPolicyDropDispositionV1
}

/**
 * One user/project/local settings layer the STRICT tier rejected.
 *
 * `managed-settings.md#keys-that-fail-closed`, last paragraph — "User, project,
 * and local settings files remain strict: a file whose JSON or top-level shape
 * fails validation is rejected as a whole and reported, and an individual entry
 * that fails, such as a malformed permission rule, is skipped with a warning
 * while the rest of the file applies."
 *
 * That sentence is quoted in FULL on purpose. This docblock used to carry it cut
 * at "…rejected as a whole and reported", and the half it dropped is the half
 * that qualifies this type: the page gives the strict tier TWO dispositions, not
 * one. `settings.md#fix-a-broken-settings-file` names them — a **Settings
 * Error** ("a user, project, or local file has invalid JSON or a value the
 * schema rejects") against a **Settings Warning** ("only individual entries
 * fail… Claude Code skips those values and keeps the rest of the file in
 * effect"). It lives beside the managed drop for the same reason
 * {@link sanitizeSettingsDiagnostic} does: the two tiers reject differently but
 * a reader displays them the same way, and that same section sends a user to one
 * surface for both — "run `/status` to see the affected files and `claude doctor`
 * for the details of each error."
 *
 * Deliberately not a {@link ManagedPolicyDropV1}: there is no `field`, because the case this type models rejects the
 * layer WHOLE, and no disposition, because within that case there is only one. RESIDUE, stated rather than implied: the
 * per-entry **Settings Warning** disposition is a second strict-tier outcome this type does not express, nor reports.
 */
export interface RejectedSettingsLayerV1 {
  /** The file the layer came from. */
  readonly source: string
  /** The top-level key whose contribution was rejected whole. */
  readonly key: string
  /** The strict parser's own message, already sanitized. */
  readonly reason: string
  /** F1.1043 — NOT rejected: a settings-file credential the runtime USES; the doctor lists it apart, never as a finding. */
  readonly inUse?: true | undefined
}

/**
 * Where a rejected entry goes. The strict sink throws, which is the whole of
 * the pre-R25a behaviour; the tolerant sink records and lets the caller install
 * a per-field fallback.
 */
export interface ManagedDropSink {
  readonly tolerant: boolean
  drop(field: string, reason: string, disposition: ManagedPolicyDropDispositionV1): void
}

export const STRICT_DROP_SINK: ManagedDropSink = {
  tolerant: false,
  drop(_field, reason) {
    throw new Error(reason)
  },
}

export function collectingDropSink(source: string, drops: ManagedPolicyDropV1[]): ManagedDropSink {
  return {
    tolerant: true,
    drop(field, reason, disposition) {
      drops.push(Object.freeze({ source, field, reason, disposition }))
    },
  }
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------------- *
 * Rendering — the reader half of the three consumers in
 * `managed-settings.md#find-entries-claude-code-dropped`
 * ------------------------------------------------------------------------- */

/**
 * Everything a drop line carries is ATTACKER-INFLUENCED text.
 *
 * `field` can be an arbitrary key off the document (`refuseUnknownKeys` reports
 * the key verbatim) and `reason` can quote a rule string up to 2048 characters
 * (`parseManagedClaudeRulesV1`). Both reach a terminal — the headless summary
 * goes to stderr — so a control character in a policy could otherwise repaint
 * the operator's screen or forge a second log line. Rendering strips the whole
 * C0/C1/DEL/line-separator class and caps the length; the parse layer keeps its
 * own validation, this is the belt on the display side.
 */
const DROP_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
const DROP_FIELD_MAX = 120
const DROP_REASON_MAX = 200
const DROP_SOURCE_MAX = 200

/**
 * The cap for a {@link RejectedSettingsLayerV1} `reason` — 400, not the 200 the
 * managed-DROP reasons use, and EXPORTED because one field with two halves
 * cannot have two numbers.
 *
 * Why 400: a managed drop's reason is a parser message about one field, and 200
 * holds it. A rejected LAYER's reason is the only place a whole-layer refusal
 * explains itself, and P3.373's user `env` refusal has to carry a disclosure —
 * the documented key, the reason it is refused, and the supported route
 * instead — which at 200 truncates exactly where the divergence is named.
 *
 * Why exported: the value is written by the PRODUCERS (`config/storage.ts`'s
 * `reportRejectedUserSettingsLayer` and `reportUnhonouredUserEnvBlock`) and read
 * by the RENDERER (`config-doctor.ts`), and until this constant existed those
 * halves were separate literals — one producer at 400, the renderer at 400, and
 * the general producer at the 200 default, so a reason that survived its
 * producer could still be cut by the reader, or the reverse. Nothing was wrong
 * at the values in the tree, which is exactly why it would have drifted (P6.639).
 *
 * NO RESIDUE as of P6.639's close: all three sites read this symbol, and
 * `user-settings-strict-report.test.ts` drives the strict-tier producer through
 * the real loader with a reason longer than the old 200 default and asserts it
 * arrives whole. `git grep -an 'sanitizeSettingsDiagnostic' -- packages/shared/src/config`
 * is the census that keeps a fourth producer from appearing at the default.
 */
export const REJECTED_LAYER_REASON_MAX = 400

/**
 * Flatten and cap one piece of settings-derived text for display.
 *
 * Exported because the USER tier needs the same treatment:
 * `managed-settings.md#keys-that-fail-closed` requires a rejected
 * user/project/local file to be "rejected as a whole and reported", and the
 * parser message that report carries quotes the offending key.
 */
export function sanitizeSettingsDiagnostic(value: string, max = DROP_REASON_MAX): string {
  const flattened = value.replace(DROP_CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim()
  return flattened.length <= max ? flattened : `${flattened.slice(0, max - 1)}…`
}

/**
 * What the tolerant parse DID, in an admin's words rather than the enum's.
 * `stripped` is the only disposition the general description in
 * `managed-settings.md#find-entries-claude-code-dropped` reaches — "Claude Code
 * first skips the individual entries it can repair… then drops any top-level key
 * whose value still fails and keeps enforcing every remaining valid key." The
 * other two come from the per-field table in
 * `managed-settings.md#keys-that-fail-closed`, where a defect is reinterpreted
 * instead of removed — an admin reading a summary needs to know which of the
 * three happened, because only one of them changes nothing.
 */
const DISPOSITION_EFFECT: Readonly<Record<ManagedPolicyDropDispositionV1, string>> =
  Object.freeze({
    stripped: 'ignored',
    emptied: 'enforced as an empty allowlist',
    tightened: 'read at its enforcing value',
  })

/**
 * Documented managed keys this product deliberately does not carry, and what an
 * administrator should do instead — P6.240.
 *
 * The defect this closes is not that `claudeMd` was dropped without a name: the
 * tolerant parser already records `{field: 'claudeMd', reason: 'invalid managed
 * Pi policy key: claudeMd'}` (measured at HEAD `b00b9c732`). It is that the
 * reason is BYTE-IDENTICAL to a typo — a delivered `claudeMd` and a delivered
 * `totallyUnknownKey` render the same sentence — so an administrator following
 * `memory.md`'s managed-instruction section reads our refusal as their own
 * mistake and has no route to try next.
 *
 * `claudeMd` is refused rather than carried, which is the arm the row calls
 * "always correct": owner ruling R50 (`…parity-audit.md:783`, "there are no
 * third-party administrators") withdraws the fleet-admin premise the key exists
 * for, while the SUPPORTED route already ships and needs no schema — the managed
 * instruction FILE at {@link MANAGED_INSTRUCTION_FILE} in the managed system
 * directory, which is read on all three runtimes and, per `memory.md`, "cannot
 * be excluded". So the honest change is one sentence at the rendering seam, not
 * a carrier.
 *
 * `hooks` is DELIBERATELY NOT IN THIS TABLE even though it sits beside
 * `claudeMd` in the same docblock at `managed-approval.ts`: its posture is not
 * settled — a managed hook carrier is a live question in this plan — and a note
 * saying "refused by design" would pre-empt it. Its drop keeps the generic
 * reason, which still names the key. Add a key here only when the refusal is a
 * decided posture with a named alternative.
 */
const MANAGED_KEY_REFUSED_BY_DESIGN: Readonly<Record<string, string>> = Object.freeze({
  claudeMd: 'refused by design: this product carries no managed instruction KEY — '
    + `put the organisation's instructions in a managed ${MANAGED_INSTRUCTION_FILE} `
    + 'in the managed system directory, which is read and cannot be excluded',
})

/**
 * The refusal note for a dropped field, or `undefined` when the drop is an
 * ordinary invalid entry.
 *
 * Matched on the field's FIRST path segment, so a nested spelling
 * (`claudeMd.content`) is answered the same way a top-level one is; unknown-key
 * drops are top-level today, and the segment form costs nothing and cannot
 * silently miss.
 */
export function managedKeyRefusalNote(field: string): string | undefined {
  const head = field.split(/[.[]/, 1)[0] ?? ''
  return head.length === 0 ? undefined : MANAGED_KEY_REFUSED_BY_DESIGN[head]
}

/**
 * One drop as a single line: source, field, reason, effect.
 *
 * This is the shared rendering every reader uses — the startup summary today
 * and the `/doctor` listing when R30b lands.
 * `managed-settings.md#find-entries-claude-code-dropped` fixes the two fields a
 * `doctor` listing must carry — it "lists each invalid entry with its source and
 * field"; both are first in the line for that reason.
 */
export function formatManagedPolicyDrop(drop: ManagedPolicyDropV1): string {
  const field = drop.field.length === 0
    ? '(whole document)'
    : sanitizeSettingsDiagnostic(drop.field, DROP_FIELD_MAX)
  // The refusal note is appended, never substituted: the strict parser's own
  // message is the record, and a rendering that replaced it would hide which
  // parse produced the drop. It is sanitized like every other span even though
  // it is our own literal — one code path, one guarantee.
  const refusal = managedKeyRefusalNote(drop.field)
  const note = refusal === undefined
    ? ''
    : ` — ${sanitizeSettingsDiagnostic(refusal, DROP_REASON_MAX)}`
  return `${sanitizeSettingsDiagnostic(drop.source, DROP_SOURCE_MAX)}: ${field} — `
    + `${sanitizeSettingsDiagnostic(drop.reason, DROP_REASON_MAX)}${note}`
    + ` [${DISPOSITION_EFFECT[drop.disposition]}]`
}

/**
 * The whole drop list as a summary block, or `undefined` when there is nothing
 * to report.
 *
 * `managed-settings.md#find-entries-claude-code-dropped` — "Non-interactive
 * runs with `-p` print a summary to stderr." (this docblock previously put the
 * words *Headless runs* inside those quotation marks, where the page says
 * Non-interactive — a paraphrase wearing quote marks is the failure mode the
 * page-anchor rule exists to stop, and no renumbering would ever have caught
 * it). Our headless
 * host has no `-p`, so the summary is printed on every headless start; the
 * desktop shell prints the same block to its main log until the startup dialog
 * of the same list's first bullet exists.
 */
export function formatManagedPolicyDropSummary(
  drops: readonly ManagedPolicyDropV1[],
): string | undefined {
  if (drops.length === 0) return undefined
  const heading = drops.length === 1
    ? '1 managed settings entry was not applied:'
    : `${drops.length} managed settings entries were not applied:`
  return [heading, ...drops.map(drop => `  - ${formatManagedPolicyDrop(drop)}`)].join('\n')
}

/**
 * Print the summary. Returns the number of drops reported so a caller can
 * assert on it without re-deriving the list.
 *
 * The default sink is `console.warn`, which is stderr in both hosts — the
 * desktop main process and the headless server — so one call satisfies both the
 * startup-dialog bullet and the stderr-summary bullet of
 * `managed-settings.md#find-entries-claude-code-dropped` at the coarse level. It
 * is NOT the startup
 * dialog: that surface is still missing, and this function is what keeps the
 * record from being invisible in the meantime.
 */
export function reportManagedPolicyDrops(
  drops: readonly ManagedPolicyDropV1[],
  options: { write?: (message: string) => void } = {},
): number {
  const summary = formatManagedPolicyDropSummary(drops)
  if (summary === undefined) return 0
  const write = options.write ?? ((message: string) => { console.warn(message) })
  write(`[managed-settings] ${summary}`)
  return drops.length
}

/**
 * Run one field's strict parse. Under the strict sink the throw propagates
 * unchanged; under the tolerant sink the field is recorded and replaced by
 * `fallback`, which is where `managed-settings.md#keys-that-fail-closed`'s
 * per-field table lives.
 */
export function tolerate<T>(
  sink: ManagedDropSink,
  field: string,
  disposition: ManagedPolicyDropDispositionV1,
  parse: () => T,
  fallback: T,
): T {
  try {
    return parse()
  } catch (error) {
    sink.drop(field, reasonOf(error), disposition)
    return fallback
  }
}

/**
 * A managed list under the per-field table, which is the trap between two rows
 * of `managed-settings.md#keys-that-fail-closed`: an invalid `allowedMcpServers`
 * is "Enforced as an empty allowlist, so no MCP servers are admitted until the
 * value is fixed", while an invalid `deniedMcpServers` is "dropped with a
 * warning, since denying every server would block servers the policy never
 * named". Same defect, opposite directions, decided by `kind`.
 *
 * An individual invalid entry is stripped either way and the valid subset is
 * enforced. Entries are validated by running the strict parser over a
 * one-element array, so tolerance can never drift from the strict rules.
 */
export function toleratedList<T>(
  sink: ManagedDropSink,
  field: string,
  value: unknown,
  strict: (value: unknown) => readonly T[],
  kind: 'grant' | 'restrict',
): readonly T[] | undefined {
  if (!sink.tolerant) return strict(value)
  try {
    return strict(value)
  } catch (error) {
    if (!Array.isArray(value)) {
      sink.drop(field, reasonOf(error), kind === 'grant' ? 'emptied' : 'stripped')
      return kind === 'grant' ? Object.freeze([]) : undefined
    }
  }
  // Re-run the strict parser over the subset kept SO FAR plus the candidate, so
  // whole-list rules an entry can violate on its own — duplicates, the length
  // cap — are caught per entry instead of failing the list.
  const kept: unknown[] = []
  for (const [index, entry] of (value as unknown[]).entries()) {
    try {
      strict([...kept, entry])
      kept.push(entry)
    } catch (error) {
      sink.drop(`${field}[${index}]`, reasonOf(error), 'stripped')
    }
  }
  return strict(kept)
}
