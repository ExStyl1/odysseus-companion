/**
 * check-wire-exact-lists — the instrument that found D1.264, as a ratchet.
 *
 * D1.280.
 *
 * ## The defect class, and why no compiler catches it
 *
 * `packages/shared/src/protocol/pi-harness-runtime.ts` parses the Pi harness
 * wire payloads and calls `exact(value, [...])` on every object it accepts: a
 * key not in the list makes the whole payload throw. The wire TYPES live in
 * `packages/core/src/types/`. Nothing compared the two, and both directions
 * shipped in one night (D1.264, HIGH):
 *
 *  - `pendingAsk.questions` was declared on the type, emitted by the producer,
 *    and in no `exact()` list — so every batched AskUserQuestion threw.
 *  - `mcpHealth.failureReasons` was published by a SPREAD of a foreign object
 *    (`{ ...McpClientPool.health() }`), which TypeScript's excess-property check
 *    does not apply to, so the producer type-checked against a wire type it was
 *    violating and the parser rejected the payload from the first turn onwards.
 *
 * The instrument that found both took minutes: diff every field name the wire
 * types declare against every key the parser admits. That is this file.
 *
 * ## The two directions are not symmetric, and only one is a hard zero
 *
 * ALLOWED-but-undeclared — a key in an `exact()` list that NO core wire type
 * declares — is a hard failure at zero. It means the parser admits a field the
 * contract does not have: either a stale allowance left by a rename, or a field
 * being let through that no consumer can read. Measured 2026-09-18: **0**.
 *
 * DECLARED-but-unparsed is softer, because the pi-harness types file also holds
 * payloads that travel on OTHER channels (the isolation capability report is a
 * settings-page RPC, and the snapshot RESULT wrapper is never parsed as a
 * payload). Those names are listed below WITH their reason, and the gate fails
 * on a name that is neither parsed nor listed — which is exactly
 * `pendingAsk.questions`' shape.
 *
 * ## What it deliberately does NOT do
 *
 * It does not match a field to its own interface. Ownership cannot be derived
 * from the two files — an `exact()` list is a positional argument inside a
 * parser function, not a named type — and a rule that guessed would cry wolf on
 * every shared field name. AGENTS.md: a rule that cries wolf is a rule people
 * stop running. Set-vs-set finds both defects this row exists for, and it
 * cannot misfire on a name that appears somewhere in both.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

/** Every wire type file the parser's payloads are declared in. */
const TYPES_DIR = 'packages/core/src/types'
/** The parser whose `exact()` lists decide what is admitted. */
const PARSER_FILE = 'packages/shared/src/protocol/pi-harness-runtime.ts'
/** The one types file whose payloads this parser is supposed to cover. */
const PARSED_TYPES_FILE = 'packages/core/src/types/pi-harness-runtime.ts'

/**
 * Names declared in `pi-harness-runtime.ts` that this parser is NOT supposed to
 * admit, each with the reason it is not a finding. Add a name here only after
 * reading why it is absent; a name that is absent because the parser FORGOT it
 * is the defect this gate exists for.
 *
 * Measured 2026-09-18 at HEAD: these ten and no others.
 */
export const UNPARSED_BY_DESIGN: Readonly<Record<string, string>> = Object.freeze({
  // `IsolationCapabilityReportV1` and its two members travel on the
  // `getIsolationCapabilities` RPC to the permissions settings page. They share
  // this types file and nothing else with the harness snapshot.
  backend: 'IsolationProfileCapabilityV1 — the getIsolationCapabilities RPC',
  egress: 'IsolationNetworkPostureV1 — the getIsolationCapabilities RPC',
  network: 'IsolationCapabilityReportV1 — the getIsolationCapabilities RPC',
  platform: 'IsolationCapabilityReportV1 — the getIsolationCapabilities RPC',
  profiles: 'IsolationCapabilityReportV1 — the getIsolationCapabilities RPC',
  remediation: 'IsolationProfileCapabilityV1 — the getIsolationCapabilities RPC',
  sandboxEnabled: 'IsolationCapabilityReportV1 — the getIsolationCapabilities RPC',
  unenforceable: 'IsolationNetworkPostureV1 — the getIsolationCapabilities RPC',
  // The RESULT wrapper the host returns around a parsed snapshot; it is built
  // here rather than received, so it is never a payload to admit.
  snapshot: 'PiHarnessRuntimeSnapshotResultV1 — the host-built wrapper, never parsed',
  barrierSeq: 'PiHarnessRuntimeSnapshotResultV1 — the host-built wrapper, never parsed',
})

/** Every property name a TypeScript declaration file declares, interfaces and type aliases alike. */
export function declaredNames(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/(?:^|[{;,])\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)]
      .map(match => match[1] as string),
  )
}

/** Every key any `exact(value, [...])` call in the parser admits. */
export function admittedKeys(source: string): { keys: Set<string>; lists: number } {
  const lists = [...source.matchAll(/exact\([^,]+,\s*\[([\s\S]*?)\]\)/g)]
  const keys = new Set<string>()
  for (const list of lists) {
    for (const key of (list[1] ?? '').matchAll(/'([^']+)'/g)) keys.add(key[1] as string)
  }
  return { keys, lists: lists.length }
}

export interface WireExactResult {
  /** An `exact()` key no core wire type declares. A hard failure at zero. */
  admittedButUndeclared: string[]
  /** A pi-harness field in no `exact()` list and not in {@link UNPARSED_BY_DESIGN}. */
  declaredButUnparsed: string[]
  /** For the positive control: the instrument has to be reading real files. */
  declaredCount: number
  listCount: number
  keyCount: number
}

export function measure(root: string = REPO_ROOT): WireExactResult {
  const typeFiles = execFileSync('git', ['ls-files', TYPES_DIR], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(path => path.endsWith('.ts'))
  const declared = new Set<string>()
  for (const file of typeFiles) {
    for (const name of declaredNames(readFileSync(join(root, file), 'utf8'))) declared.add(name)
  }
  const { keys, lists } = admittedKeys(readFileSync(join(root, PARSER_FILE), 'utf8'))
  const parsedTypes = declaredNames(readFileSync(join(root, PARSED_TYPES_FILE), 'utf8'))

  return {
    admittedButUndeclared: [...keys].filter(key => !declared.has(key)).sort(),
    declaredButUnparsed: [...parsedTypes]
      .filter(name => !keys.has(name) && !(name in UNPARSED_BY_DESIGN))
      .sort(),
    declaredCount: declared.size,
    listCount: lists,
    keyCount: keys.size,
  }
}

function main(argv: readonly string[]): number {
  const result = measure()

  // The positive control FIRST: an instrument reading nothing satisfies both
  // findings perfectly, which is how an absence gate disarms itself silently.
  if (result.listCount === 0 || result.declaredCount === 0) {
    console.error(
      `REFUSED: the wire/exact census read ${result.listCount} exact() list(s) and`
      + ` ${result.declaredCount} declared name(s). It is measuring nothing — check that`
      + ` ${PARSER_FILE} and ${TYPES_DIR} are where this gate expects them.`,
    )
    return 2
  }

  console.log(
    `check-wire-exact-lists: ${result.listCount} exact() list(s) admitting ${result.keyCount} key(s)`
    + ` against ${result.declaredCount} name(s) declared in ${TYPES_DIR}.`,
  )

  let failed = false
  if (result.admittedButUndeclared.length > 0) {
    failed = true
    console.log(
      `REFUSED: ${result.admittedButUndeclared.length} exact() key(s) no core wire type declares:`
      + ` ${result.admittedButUndeclared.join(', ')}.`
      + '\n  Either the type lost a field a rename should have taken with it, or the parser is'
      + '\n  letting a field through that nothing can read. Both are D1.264.',
    )
  }
  if (result.declaredButUnparsed.length > 0) {
    failed = true
    console.log(
      `REFUSED: ${result.declaredButUnparsed.length} wire field(s) in NO exact() list:`
      + ` ${result.declaredButUnparsed.join(', ')}.`
      + '\n  A field declared and emitted but not admitted makes the WHOLE payload throw — that is'
      + '\n  `pendingAsk.questions` (D1.264, HIGH). Add it to the parser, or, if it travels on a'
      + '\n  different channel, to UNPARSED_BY_DESIGN in this file WITH its reason.',
    )
  }
  if (!failed) console.log('  OK: both directions clean.')
  if (argv.includes('--check')) return failed ? 1 : 0
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
