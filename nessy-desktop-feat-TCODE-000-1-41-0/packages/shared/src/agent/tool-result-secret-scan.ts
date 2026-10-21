/**
 * The host's secret scan for TOOL RESULTS — the text a tool hands back before
 * the model's next turn reads it (P6.574), and the `structuredContent` record
 * that rides beside it on the same event (P6.753).
 *
 * WHY IT IS OURS AND NOT THE RUNTIME'S — native asked, and the answer is
 * "present, unreachable". The vendored claude binary carries a gitleaks-shaped
 * NAMED ruleset: probed at HEAD in
 * `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
 * `gitlab-pat`, `github-pat`, `aws-access-token`, `slack-bot-token` and
 * `stripe-access-token` each occur twice and `private-key` four times, against
 * a control (`NESSY_NOT_A_REAL_RULE`) of zero — 56 named rules in one table.
 * No documented setting and no env spelling exposes it, and it is claude's
 * alone in any case: Pi and codex would still see nothing. So this is
 * native-first step (2) — the host supplies it once, uniformly, for all three
 * runtimes — rather than step (1) or three separate step (3)s.
 *
 * THE PATTERNS ARE OURS, THE NAMES ARE THEIRS, and that split is deliberate.
 * AGENTS.md: "proprietary-binary extractions stay paraphrase-only", so nothing
 * here is transcribed from that binary. Each rule below is a plain
 * prefix-plus-charset matcher written against the ISSUING VENDOR's own public
 * documentation of its token prefix. The rule NAMES are aligned with the
 * binary's spelling — a name is a label, not expression — for exactly the
 * reason `goal-service.ts`'s redactor already records: so the two tables cannot
 * drift when someone compares them.
 *
 * WHAT THIS IS NOT. It is not a secret SCANNER for a repository and must never
 * grow into one: no entropy heuristics, no `generic-api-key` catch-all (the
 * binary has no such rule either — probed, zero hits), no filename rules. A
 * false positive here silently deletes text the model needed, and the model
 * cannot tell that it happened. Prefix rules are the class where a match is
 * evidence rather than a guess.
 *
 * THE NOTICE IS COUNT-ONLY, ALWAYS. The redacted text carries a marker naming
 * the rule; the notice carries the rule name and how many times it fired. The
 * matched bytes never appear in either, never reach a log, and never reach the
 * model.
 */

/** One named rule: what it is called, and what it recognises. */
export interface ToolResultSecretRule {
  /** The vendored runtime's own spelling, so the two tables can be diffed. */
  readonly name: string
  /** Global, so a single result can carry several. */
  readonly pattern: RegExp
}

/**
 * The table, ordered MOST SPECIFIC FIRST.
 *
 * Order is load-bearing rather than cosmetic: the scan replaces as it goes, so
 * a longer prefix that is also a prefix of a shorter rule (`sk-ant-admin01-`
 * inside `sk-ant-`) must fire first or the specific rule can never be reported.
 */
export const TOOL_RESULT_SECRET_RULES: readonly ToolResultSecretRule[] = Object.freeze([
  // Anthropic — `sk-ant-admin01-` before `sk-ant-`, see the ordering note.
  { name: 'anthropic-admin-api-key', pattern: /\bsk-ant-admin01-[A-Za-z0-9_-]{16,}/g },
  { name: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  // OpenAI publishes `sk-` project keys; the length floor is what keeps `sk-`
  // in ordinary prose from matching.
  { name: 'openai-api-key', pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}/g },
  // GitHub's five documented prefixes (`ghp` personal, `gho` OAuth, `ghu`/`ghs`
  // app, `ghr` refresh) plus the fine-grained form.
  { name: 'github-fine-grained-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'github-pat', pattern: /\bghp_[A-Za-z0-9]{20,}/g },
  { name: 'github-oauth', pattern: /\bgho_[A-Za-z0-9]{20,}/g },
  { name: 'github-app-token', pattern: /\bgh[us]_[A-Za-z0-9]{20,}/g },
  { name: 'github-refresh-token', pattern: /\bghr_[A-Za-z0-9]{20,}/g },
  // GitLab — OUR OWN token family (A21), which is why the row named it first.
  // GitLab documents each of these prefixes; `glpat-` and `glrt-` are the two
  // an engineer here actually pastes.
  { name: 'gitlab-pat', pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { name: 'gitlab-runner-authentication-token', pattern: /\bglrt-[A-Za-z0-9_-]{16,}/g },
  { name: 'gitlab-deploy-token', pattern: /\bgldt-[A-Za-z0-9_-]{16,}/g },
  { name: 'gitlab-oauth-app-secret', pattern: /\bgloas-[A-Za-z0-9_-]{16,}/g },
  { name: 'gitlab-pipeline-trigger-token', pattern: /\bglptt-[A-Za-z0-9_-]{16,}/g },
  { name: 'gitlab-kubernetes-agent-token', pattern: /\bglagent-[A-Za-z0-9_-]{16,}/g },
  { name: 'gitlab-incoming-mail-token', pattern: /\bglimt-[A-Za-z0-9_-]{16,}/g },
  { name: 'gitlab-scim-oauth-token', pattern: /\bglsoat-[A-Za-z0-9_-]{16,}/g },
  { name: 'gitlab-ci-build-token', pattern: /\bglcbt-[A-Za-z0-9_-]{16,}/g },
  { name: 'gitlab-feed-token', pattern: /\bglft-[A-Za-z0-9_-]{16,}/g },
  { name: 'gitlab-feature-flag-client-token', pattern: /\bglffct-[A-Za-z0-9_-]{16,}/g },
  // Cloud providers.
  { name: 'aws-access-token', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g },
  { name: 'gcp-api-key', pattern: /\bAIza[A-Za-z0-9_-]{30,}/g },
  { name: 'google-oauth-client-secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g },
  // Everything else that publishes a prefix.
  { name: 'slack-bot-token', pattern: /\bxoxb-[0-9]{8,}-[0-9]{8,}[A-Za-z0-9-]*/g },
  { name: 'slack-user-token', pattern: /\bxox[pe]-[0-9]{8,}-[0-9]{8,}-[0-9]{8,}-[A-Za-z0-9-]{16,}/g },
  { name: 'slack-app-token', pattern: /\bxapp-[0-9]-[A-Z0-9]+-[0-9]+-[a-z0-9]+/g },
  { name: 'npm-access-token', pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
  { name: 'pypi-upload-token', pattern: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g },
  { name: 'sendgrid-api-token', pattern: /\bSG\.[A-Za-z0-9_.-]{40,}/g },
  { name: 'stripe-access-token', pattern: /\b[rs]k_(?:test|live|prod)_[A-Za-z0-9]{10,}/g },
  { name: 'shopify-access-token', pattern: /\bshpat_[a-fA-F0-9]{20,}/g },
  { name: 'shopify-shared-secret', pattern: /\bshpss_[a-fA-F0-9]{20,}/g },
  { name: 'digitalocean-pat', pattern: /\bdop_v1_[a-f0-9]{32,}/g },
  { name: 'digitalocean-access-token', pattern: /\bdoo_v1_[a-f0-9]{32,}/g },
  { name: 'huggingface-access-token', pattern: /\bhf_[A-Za-z]{30,}/g },
  { name: 'supabase-secret-key', pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}/g },
  { name: 'supabase-access-token', pattern: /\bsbp_[a-z0-9]{32,}/g },
  { name: 'grafana-cloud-api-token', pattern: /\bglc_[A-Za-z0-9+/]{24,}={0,3}/g },
  { name: 'grafana-service-account-token', pattern: /\bglsa_[A-Za-z0-9]{24,}_[A-Fa-f0-9]{6,}/g },
  { name: 'sentry-user-token', pattern: /\bsntryu_[a-f0-9]{32,}/g },
  { name: 'databricks-api-token', pattern: /\bdapi[a-f0-9]{28,}(?:-\d)?/g },
  { name: 'pulumi-api-token', pattern: /\bpul-[a-f0-9]{32,}/g },
  { name: 'postman-api-token', pattern: /\bPMAK-[a-fA-F0-9]{20,}-[a-fA-F0-9]{20,}/g },
  { name: 'twilio-api-key', pattern: /\bSK[0-9a-fA-F]{32}\b/g },
  // Not a prefix rule: a PEM header is an exact literal, so it cannot false-positive.
  { name: 'private-key', pattern: /-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/g },
  ...credentialTransportRules(), // F1.365 — JWT, Ory, Bearer; LAST on purpose, see the end of this file
])

/** Every rule name, for pins and for diffing against the runtime's own table. */
export const TOOL_RESULT_SECRET_RULE_NAMES: readonly string[] =
  Object.freeze(TOOL_RESULT_SECRET_RULES.map(rule => rule.name))

/**
 * The COARSE prefix list, for redactors whose over-redaction is cheap.
 *
 * `goal-service.ts` reads it: what that module redacts is the prompt handed to
 * a goal-evaluation judge, where redacting one identifier too many costs
 * nothing and leaking one costs everything. It is therefore DELIBERATELY
 * BROADER than {@link TOOL_RESULT_SECRET_RULES} in exactly one place — a bare
 * `sk-`, which the precise table refuses because `sk-` appears in ordinary
 * prose and source (`const sk = …`) and a false positive on the TOOL-RESULT
 * path silently deletes text the model needed and cannot notice is missing.
 *
 * Shared rather than copied so the two cannot drift about WHICH FAMILIES
 * exist; the asymmetry above is the one intended difference and is pinned by a
 * test. This list is not a second rule table and must not grow into one.
 */
export const TOOL_RESULT_SECRET_TOKEN_PREFIXES: readonly string[] = Object.freeze([
  'sk-', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'glpat-', 'glrt-',
])

/**
 * The one member of the coarse list the precise table does NOT recognise on its
 * own. Named so the difference is a decision with a test, not a gap.
 */
export const COARSE_ONLY_TOKEN_PREFIXES: readonly string[] = Object.freeze(['sk-'])

export interface ToolResultSecretScan {
  /** The text to hand the model: every match replaced by its rule's marker. */
  readonly text: string
  /** Rule name to number of matches, in table order. Empty when clean. */
  readonly counts: ReadonlyArray<{ readonly rule: string; readonly count: number }>
  /**
   * The one line a caller may show or log. COUNT-ONLY, by construction — it is
   * built from `counts` and never sees the matched bytes. `undefined` when
   * nothing fired, so a clean result costs a caller nothing.
   */
  readonly notice?: string
}

/** What a match is replaced with. Names the rule, carries none of the match. */
function marker(rule: string): string {
  return `[REDACTED:${rule}]`
}

/**
 * Scan one tool result.
 *
 * Rules are applied IN TABLE ORDER against the text as it stands, so an earlier
 * replacement is invisible to the later rules — that is what makes the
 * specific-before-general ordering work, and it is also why a marker can never
 * be re-matched (it carries no token prefix).
 */
export function scanToolResultForSecrets(input: string): ToolResultSecretScan {
  if (!input) return { text: input, counts: [] }
  let text = input
  const counts: Array<{ rule: string; count: number }> = []
  for (const { name, pattern } of TOOL_RESULT_SECRET_RULES) {
    let count = 0
    // A fresh regex per pass: the table's literals are shared across sessions
    // and a `g` regex carries `lastIndex`, which is exactly the kind of state
    // that makes a scanner miss every second call.
    text = text.replace(new RegExp(pattern.source, pattern.flags), () => {
      count += 1
      return marker(name)
    })
    if (count > 0) counts.push({ rule: name, count })
  }
  if (counts.length === 0) return { text, counts: [] }
  return { text, counts, notice: buildSecretNotice(counts) }
}

/**
 * The whole call, for a caller whose result is one string and whose only
 * channel back to the model is that string — which is both event adapters.
 *
 * Written once here rather than twice in `backend/claude` and `backend/codex`
 * because the shape carries two of the three rules the Pi arm learned, and a
 * second copy is where one of them goes missing: the notice is APPENDED (the
 * model is told bytes were removed rather than handed a text that quietly lost
 * them), and a clean result is returned IDENTICALLY — not re-joined, not
 * re-serialised — so a runtime that never sees a credential is byte-identical
 * to what it was before this scan existed.
 *
 * The third rule belongs to the call SITE and cannot be moved here: scan before
 * any size guard and outside its early return.
 */
export function scrubToolResultText(input: string): string {
  return scrubToolResultPayload(input).text
}

/**
 * The MACHINE payload beside the text — `structuredContent` (P6.753).
 *
 * P6.574 scanned the tool result's TEXT and STATED the exclusion; the exclusion
 * was the residue. A credential that arrives only in `structuredContent` rides
 * the `tool_result` event unread, and the event is persisted with the session,
 * so the field is not a place a credential passes through — it is a place one
 * comes to rest.
 *
 * The exclusion's stated reason was that rewriting values inside an arbitrary
 * object would corrupt shapes the UI parses. Measured 2026-09-08, neither half
 * of that reason survives for a STRING-LEAF scan:
 *
 *   - Nothing in this tree reads `tool_result.structuredContent` by name.
 *     `git grep structuredContent -- apps packages/core packages/server-core`
 *     returns the type declaration in `core/types/message.ts` and one vendored
 *     bundle, and nothing else. The field is carried, not parsed.
 *   - A string leaf is replaced by a string. Keys are untouched, arrays keep
 *     their length and order, and every non-string leaf is returned by
 *     IDENTITY. So every shape a reader could parse survives exactly, except
 *     for the credential bytes inside a string — which is the point.
 *
 * The walk carries NO visited set, and that is a decision rather than an
 * oversight: both inputs are JSON that crossed a wire (codex's
 * `item.result.structuredContent`, Pi's `details.structuredContent`), and JSON
 * cannot be cyclic. A caller that ever hands this a live object graph would
 * need one.
 *
 * IDENTITY IS THE CONTRACT, as it is for the text: when nothing fires, BOTH the
 * text and the record come back as the very objects that went in — not re-keyed,
 * not re-serialised — so a turn with no credential in it is byte-for-byte what
 * it was before this scan existed.
 *
 * ONE notice covers both halves, because there is one tool result. The counts
 * from the text and from the record are merged and rendered in table order by
 * {@link buildSecretNotice}, and the notice is appended to the TEXT, which is
 * the half a human and a model both read.
 */
export interface ToolResultPayloadScan {
  /** The text, with the merged count-only notice appended when anything fired. */
  readonly text: string
  /** The record with its string leaves scrubbed; absent when the caller had none. */
  readonly structuredContent?: Record<string, unknown>
}

export function scrubToolResultPayload(
  text: string,
  structuredContent?: Record<string, unknown>,
): ToolResultPayloadScan {
  const tally = new Map<string, number>()
  const scannedText = scrubTree(text, tally) as string
  const scannedStructured = structuredContent === undefined
    ? undefined
    : scrubTree(structuredContent, tally) as Record<string, unknown>
  if (tally.size === 0) {
    return { text, ...(structuredContent === undefined ? {} : { structuredContent }) }
  }
  const counts = TOOL_RESULT_SECRET_RULE_NAMES
    .filter(name => tally.has(name))
    .map(name => ({ rule: name, count: tally.get(name) ?? 0 }))
  return {
    text: `${scannedText}\n\n${buildSecretNotice(counts)}`,
    ...(scannedStructured === undefined ? {} : { structuredContent: scannedStructured }),
  }
}

/**
 * Scrub the string leaves of an arbitrary JSON value, tallying by rule name.
 *
 * Returns the INPUT ITSELF whenever nothing below it changed — that identity is
 * what {@link scrubToolResultPayload}'s byte-identical contract rests on, and it
 * is why every branch compares references rather than trusting a flag.
 */
function scrubTree(value: unknown, tally: Map<string, number>): unknown {
  if (typeof value === 'string') {
    const scan = scanToolResultForSecrets(value)
    if (scan.counts.length === 0) return value
    for (const { rule, count } of scan.counts) tally.set(rule, (tally.get(rule) ?? 0) + count)
    return scan.text
  }
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map(entry => {
      const scrubbed = scrubTree(entry, tally)
      if (scrubbed !== entry) changed = true
      return scrubbed
    })
    return changed ? next : value
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const scrubbed = scrubTree(entry, tally)
      if (scrubbed !== entry) changed = true
      next[key] = scrubbed
    }
    return changed ? next : value
  }
  return value
}

/**
 * The count-only sentence. Separate and exported so a caller that already has
 * counts (a batch of results, say) can render one line for all of them without
 * ever touching the text again.
 */
export function buildSecretNotice(
  counts: ReadonlyArray<{ readonly rule: string; readonly count: number }>,
): string {
  const total = counts.reduce((sum, entry) => sum + entry.count, 0)
  const detail = counts.map(entry => `${entry.rule}×${entry.count}`).join(', ')
  return `[nessy] ${total} credential-shaped value${total === 1 ? '' : 's'} redacted from this tool result (${detail}). The values were not shown to the model.`
}

/**
 * F1.309 / F1.310 (origin WJ-ee verifier F1.236-a/-b, 2026-09-23) — the
 * KNOWN-VALUE half of keeping a credential out of text a tool hands back.
 *
 * The table above recognises a credential by its SHAPE. A caller that is
 * holding the credential it just sent knows it by VALUE, and needs no shape at
 * all: `createApiTool`'s catch path and its 4xx body line (`sources/api-tools.ts`)
 * and `source_test`'s authenticated probe (`session-tools-core`
 * `handlers/source-test.ts`) each return a runtime's error message or an API's
 * error body to the model, and both can quote the value — bun refuses a header
 * carrying a zero-width space, smart quotes or an LF with `Header '…' has
 * invalid value: '<value>'`, and an API may answer `invalid key: <key>`.
 *
 * This is an exact match against values the caller supplies, not a heuristic,
 * so the "no entropy heuristics" rule at the top of this file is not bent by it.
 * For each value it masks the forms an error text is measured or expected to
 * echo it in: verbatim, URL-encoded (a query-auth URL carries
 * `encodeURIComponent(key)`), JSON-escaped (a message that escapes an LF),
 * base64 (a Basic header carries `base64(user:password)` — the caller passes the
 * pair), and every run of printable ASCII inside it of at least
 * {@link KNOWN_VALUE_SEGMENT_MIN_LENGTH} characters (a message that stops or
 * re-renders at the one invalid character still quotes the rest). Longest form
 * first, so a shorter form never leaves the tail of a longer one behind.
 *
 * A value shorter than {@link KNOWN_VALUE_MIN_LENGTH} is not masked: at one to
 * three characters it identifies nothing and would shred every message it
 * touched. That residue is stated, not hidden.
 */
export const KNOWN_CREDENTIAL_MARKER = '[REDACTED:credential]'
export const KNOWN_VALUE_MIN_LENGTH = 4
export const KNOWN_VALUE_SEGMENT_MIN_LENGTH = 8

/** Every form of one value that {@link maskKnownCredentialValues} removes. */
export function knownCredentialForms(value: string): string[] {
  if (value.length < KNOWN_VALUE_MIN_LENGTH) return []
  const forms = new Set<string>([value])
  try {
    forms.add(encodeURIComponent(value))
  } catch {
    // A lone surrogate has no URL encoding, so nothing can carry it in that form.
  }
  forms.add(JSON.stringify(value).slice(1, -1))
  forms.add(Buffer.from(value, 'utf8').toString('base64'))
  for (const segment of value.split(/[^\x21-\x7e]+/u)) {
    if (segment.length >= KNOWN_VALUE_SEGMENT_MIN_LENGTH) forms.add(segment)
  }
  return [...forms].filter(form => form.length >= KNOWN_VALUE_MIN_LENGTH)
}

/**
 * Mask every known form of every value in `values` out of `text`. A text that
 * contains none of them comes back IDENTICAL, so a caller whose error carries no
 * credential is unchanged by this.
 */
export function maskKnownCredentialValues(text: string, values: Iterable<string | null | undefined>): string {
  if (!text) return text
  const forms = new Set<string>()
  for (const value of values) {
    if (typeof value === 'string') for (const form of knownCredentialForms(value)) forms.add(form)
  }
  let masked = text
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    if (masked.includes(form)) masked = masked.split(form).join(KNOWN_CREDENTIAL_MARKER)
  }
  return masked
}

/**
 * F1.365 (origin t-artifacts research of the upstream-refresh session,
 * 2026-09-23; DECIDED by the controller the same day, reversible) — the three
 * shapes a credential takes IN TRANSPORT rather than by issuer prefix: a JWT
 * (the Nestor gateway token, which lives two years), an Ory token (a dp
 * session), and a `Bearer` credential. Before this row the table recognised
 * none of them, so a tool that printed the gateway JWT or `dp auth print-token`
 * handed it to the model and to the session JSONL unmasked.
 *
 * The patterns are the 1.42.0 plan's UA1.17 publish-guard rules, verbatim, so
 * the two cannot drift: a JWT is three base64url segments of at least ten
 * characters, the first opening `eyJ` (base64 of `{"`, which every JOSE header
 * begins with); an Ory token is `ory_` + `at`/`rt`/`st`/`ht` + `_` and at least
 * twenty token characters; a Bearer credential is the word, case-insensitive,
 * whitespace, and at least twenty token68 characters. The length floors are
 * what keep prose out: `Bearer x`, `Bearer with no value` and a two-segment
 * `eyJ…` string do not match.
 *
 * ORDER: they are appended LAST (the table is applied in order, and an earlier
 * replacement is invisible to a later rule), so `Bearer <a github PAT>` is
 * reported as `github-pat` and `Bearer <a JWT>` as `jwt` — the specific name,
 * once — and the Bearer rule only fires on a value no named rule recognised.
 *
 * WHAT THIS BENDS in the header's "prefix rules only" stance: `bearer` is a
 * CONTEXT rule (a keyword and a value), not an issuer prefix. It is admitted
 * because the keyword is the HTTP scheme's own name, so a match is still
 * evidence rather than a guess, and because the notice below makes every
 * removal visible to the model and the user — the transparency the decision
 * was taken on. A function declaration (hoisted) rather than a `const`, so the
 * table above can spread it without moving the cited line below it.
 */
function credentialTransportRules(): ToolResultSecretRule[] {
  return [
    { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    { name: 'ory-token', pattern: /\bory_(?:at|rt|st|ht)_[A-Za-z0-9_-]{20,}/g },
    { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*/gi },
  ]
}
