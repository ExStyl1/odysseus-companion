/**
 * P2.116 — the `source-state-schema` half of
 * `src/__tests__/harness-contract/fixtures/tool-surface.json`, in one place, so
 * the pin, the test that asserts it and the gate that blocks on it cannot drift
 * apart.
 *
 * WHAT THESE DIGESTS ARE. Six orchestrator tools cannot be imported for a live
 * schema the way every other pinned tool is — the fixture says so in its own
 * `inputCodec` — so their contract is pinned as a sha256 over the factory's
 * SOURCE TEXT. P6.877 added a SEVENTH of the same class, `mcp.dynamic`, whose
 * payload is two source regions rather than one factory
 * ({@link DYNAMIC_WIRE_SOURCE_PIN}); everything below about what a source-text
 * digest is and is not applies to it identically. That makes each one a change-detector on the whole factory,
 * implementation included, and NOT a model-surface pin: an ordinary edit inside
 * `execute` moves it while the model sees nothing new. Which is exactly why it
 * kept going red with nobody caring.
 *
 * WHY THE GATE MOVED. Measured 2026-08-27, two instances of one shape:
 *   - `agent.subagent` went stale at `00346ed67` and stayed red on HEAD for six
 *     commits, until `32e98c89b` re-pinned it as a side effect.
 *   - `workflow.execute` went stale at `bf9e10328` (a comment and one `push`
 *     inside `execute`; the model-facing declaration did not move) and was
 *     still red **33 commits later** at `b9d56f38b`, the base this row started
 *     from — 47 commits and ~33 hours from the fix's own parent.
 * The guard existed both times: `pi-harness-baseline.test.ts`'s "pins
 * deterministic production schema contracts for every effective tool", which
 * root `bun test` — CI's `test` job — really does run. The guard was there; the
 * SIGNAL was not, because no lane runs root `bun test` during an implementation
 * loop and CI never ran on the branch. So the blocking read of these digests
 * now rides `bun run typecheck` in this package: the affected-package check a
 * lane touching `src/orchestrator/*` already runs, and the one CI reaches
 * through `typecheck:all`.
 *
 * NOT THE SAME THING AS `PI_STATIC_MODEL_CONTRACT_HASHES`
 * (`shared/src/agent/pi-harness/harness-tool-descriptor.ts`), and the
 * difference is the whole point of the row. Those constants are typed in by
 * hand, but they are NOT unverified: `src/harness/live-manifest-contract.test.ts`
 * recomputes them with `hashProjectedPiToolDefinition` over four live
 * compositions and every child tool-pool. That test — not this digest — is what
 * answers "did the MODEL-FACING contract move?" when a pin here goes red.
 *
 * With ONE limit, stated because overstating it is the habit this whole file
 * exists to break — and because the first version of this paragraph said
 * "compares EVERY one of them", which is the same over-claim. Both of that
 * test's loops skip on `if (!pin) continue` / `if (!definition) continue`, so a
 * `bindingName` carried by NO composition it builds is never compared; its own
 * comment records `mcp__tool_search` and `mcp__tool_load` sitting "never
 * compared against anything" until a fourth composition was added for them.
 * Derived, yes. "Every entry", only for the entries the compositions carry.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A refusal this gate raises DELIBERATELY (a deleted field, a moved marker, an
 * internally inconsistent pin) — as opposed to a bug in the gate itself. The
 * CLI prints the message alone for these and the full stack for anything else,
 * so a real crash does not get dressed up as a fixture problem.
 */
export class SourceStateGateRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceStateGateRefusal'
  }
}

export interface SourceStateFactory {
  /** Repo-relative path of the file the factory lives in. */
  readonly path: string
  /** First byte of the hashed block. */
  readonly start: string
  /** First byte AFTER the hashed block; the rest of the file when absent. */
  readonly end?: string
  /** Key under `schemaContracts` in `fixtures/tool-surface.json`. */
  readonly semanticId: string
}

export const SOURCE_STATE_FIXTURE = 'packages/pi-agent-server/src/__tests__/harness-contract/fixtures/tool-surface.json'

/**
 * Keyed by the row's `currentName` in the fixture's `piStaticTools`, because
 * that is how the baseline test looks a factory up.
 */
export const SOURCE_STATE_FACTORIES: Readonly<Record<string, SourceStateFactory>> = Object.freeze({
  subagent: {
    path: 'packages/pi-agent-server/src/orchestrator/subagent-tool.ts',
    start: 'export function createSubagentTool',
    end: 'export function createStopTaskTool',
    semanticId: 'agent.subagent',
  },
  review: {
    path: 'packages/pi-agent-server/src/orchestrator/review-tool.ts',
    start: 'export function createReviewTool',
    semanticId: 'agent.review',
  },
  stopTask: {
    path: 'packages/pi-agent-server/src/orchestrator/subagent-tool.ts',
    start: 'export function createStopTaskTool',
    end: 'export function createGetSubagentResultTool',
    semanticId: 'agent.stop_task',
  },
  get_subagent_result: {
    path: 'packages/pi-agent-server/src/orchestrator/subagent-tool.ts',
    start: 'export function createGetSubagentResultTool',
    end: 'export function createSteerSubagentTool',
    semanticId: 'agent.get_subagent_result',
  },
  steer_subagent: {
    path: 'packages/pi-agent-server/src/orchestrator/subagent-tool.ts',
    start: 'export function createSteerSubagentTool',
    // F1.469 — the file's LAST factory, so no next factory can end it: its own closing brace
    // at column 0 does, and the helpers below it (F1.225's turnLimitNotice) stay out.
    end: '\n}\n',
    semanticId: 'agent.steer_subagent',
  },
  workflow: {
    path: 'packages/pi-agent-server/src/orchestrator/workflow-tool.ts',
    start: 'export function createWorkflowTool',
    semanticId: 'workflow.execute',
  },
})

/** The `schemaContracts` keys this gate reads, derived from the table above. */
export const SOURCE_STATE_FACTORY_SEMANTIC_IDS: readonly string[] =
  Object.values(SOURCE_STATE_FACTORIES).map(factory => factory.semanticId)

/**
 * The ONE canonicalisation every pinned digest in the fixture is taken over —
 * `schemaContract()` in `pi-harness-baseline.test.ts` imports this rather than
 * keeping a second copy, so a change to the algorithm cannot move the test's
 * oracle without moving the gate's.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** The exact text the digest is taken over. Throws, by name, on a moved marker. */
export function sourceStateFactoryBlock(repoRoot: string, factory: SourceStateFactory): string {
  const source = readFileSync(resolve(repoRoot, factory.path), 'utf8')
  const start = source.indexOf(factory.start)
  if (start < 0) {
    throw new SourceStateGateRefusal(
      `${factory.path}: start marker "${factory.start}" not found — the factory was renamed or moved. `
      + 'Update SOURCE_STATE_FACTORIES in packages/pi-agent-server/src/harness/source-state-contract.ts.',
    )
  }
  const end = factory.end ? source.indexOf(factory.end, start + factory.start.length) : source.length
  if (end <= start) {
    throw new SourceStateGateRefusal(
      `${factory.path}: end marker "${factory.end}" not found after "${factory.start}" — `
      + 'the block boundary moved. Update SOURCE_STATE_FACTORIES in '
      + 'packages/pi-agent-server/src/harness/source-state-contract.ts.',
    )
  }
  return source.slice(start, end)
}

/** The digest the fixture's three `…sha256:<hex>` fields must carry. */
export function sourceStateDigest(repoRoot: string, factory: SourceStateFactory): string {
  return createHash('sha256')
    .update(canonicalJson({ sourcePath: factory.path, factorySource: sourceStateFactoryBlock(repoRoot, factory) }))
    .digest('hex')
}

/**
 * The THREE fields of a pin that each embed the digest. Reading only the first
 * was a real hole, found by this row's review: corrupt `modelSchemaVersion`
 * alone and a gate that reads `schemaIdentity` reports `6/6 match live source`
 * and exits 0, so a hand-edited, internally inconsistent pin walks past it. The
 * two mitigations that existed were both real and both insufficient here — the
 * baseline test does compare all three, but it runs under root `bun test`,
 * which is the gate this file exists BECAUSE NOBODY RUNS.
 */
export const DIGEST_FIELDS = ['schemaIdentity', 'modelSchemaVersion', 'bindingSchemaVersion'] as const
export type DigestField = (typeof DIGEST_FIELDS)[number]

/**
 * P2.235 — the gate read the HEX and threw the rest of each field away, and the
 * rest is where three separate hazards lived.
 *
 * Each field is `<prefix><digest>`, and the prefixes are not decoration:
 * `bindingSchemaVersion` carries the TOOL'S OWN NAME (`exact-name:review/…`) and
 * `handlerSchemaVersion` carries the factory's PATH and function
 * (`…/review-tool.ts#createReviewTool.execute@…`). Comparing only the hex means:
 *
 *  - a right digest under a corrupted prefix passes (measured: relabel a
 *    `schemaIdentity` prefix, keep the hex, and the gate says
 *    `6/6 match live source, all 3 digest fields each` and exits 0);
 *  - `--pin` MANUFACTURES that state rather than merely tolerating it. Rename a
 *    tool and the digest moves, because the name is inside the hashed block;
 *    `--pin` rewrote only the hex and left a stale `exact-name:<old name>` behind,
 *    green;
 *  - `handlerSchemaVersion` was not read at all, so a factory that moved file or
 *    was renamed left a pin naming a path that no longer exists.
 *
 * So the gate now compares the WHOLE stored string against a value it derives,
 * and `--pin` writes the whole string. The one part that cannot be derived is the
 * `@<40 hex>` commit suffix on `handlerSchemaVersion`; its SHAPE is checked and
 * its value is carried through, which is stated here rather than left for a
 * reader to discover as a hole.
 */
export const PIN_FIELDS = [...DIGEST_FIELDS, 'handlerSchemaVersion'] as const
export type PinField = (typeof PIN_FIELDS)[number]

/** The factory function's own name, from the marker the table already carries. */
export function factoryFunctionName(factory: SourceStateFactory): string {
  return factory.start.replace(/^export function\s+/, '')
}

/** The `@<commit>` suffix `handlerSchemaVersion` carries, which nothing here can derive. */
const HANDLER_COMMIT = /@[0-9a-f]{40}$/

/**
 * The full value each field must carry, derived rather than restated.
 *
 * `handlerSchemaVersion` is returned with whatever commit suffix the pin already
 * holds, so this compares the half that is derivable — path and handler — and
 * leaves the half that is not alone.
 */
export function expectedPinValue(
  factory: SourceStateFactory,
  currentName: string,
  digest: string,
  field: PinField,
  stored: string,
): string {
  switch (field) {
    case 'schemaIdentity': return `source-state-schema:sha256:${digest}`
    case 'modelSchemaVersion': return `source-state-schema/sha256:${digest}`
    case 'bindingSchemaVersion': return `exact-name:${currentName}/sha256:${digest}`
    case 'handlerSchemaVersion': {
      const commit = HANDLER_COMMIT.exec(stored)?.[0] ?? '@<40-hex commit missing from the pin>'
      return `${factory.path}#${factoryFunctionName(factory)}.execute${commit}`
    }
  }
}

export interface SourceStateDrift {
  readonly currentName: string
  readonly semanticId: string
  readonly path: string
  /** The digest each field carries — they can disagree with EACH OTHER, not just with source. */
  readonly stored: Readonly<Record<DigestField, string>>
  /** The WHOLE value of every pinned field, prefix included — P2.235. */
  readonly storedFull: Readonly<Record<PinField, string>>
  /** The whole value each field should carry, derived. */
  readonly expected: Readonly<Record<PinField, string>>
  readonly live: string
  /** Which of the three digests no longer match the live source. */
  readonly mismatched: readonly DigestField[]
  /** Which fields differ as WHOLE strings — a superset of `mismatched`. */
  readonly mismatchedFull: readonly PinField[]
}

/** True when the pin's own three fields do not agree — a hand-edit, not drift. */
export function pinIsInternallyInconsistent(drift: SourceStateDrift): boolean {
  return new Set(DIGEST_FIELDS.map(field => drift.stored[field])).size !== 1
}

/** Every fixture pin whose stored digests no longer match the live source. */
export function collectSourceStateDrift(repoRoot: string): SourceStateDrift[] {
  const fixture = JSON.parse(readFileSync(resolve(repoRoot, SOURCE_STATE_FIXTURE), 'utf8')) as {
    schemaContracts?: Record<string, Record<string, string>>
  }
  const drift: SourceStateDrift[] = []
  for (const [currentName, factory] of Object.entries(SOURCE_STATE_FACTORIES)) {
    const contract = fixture.schemaContracts?.[factory.semanticId]
    const stored = {} as Record<DigestField, string>
    for (const field of DIGEST_FIELDS) {
      const value = contract?.[field]
      if (typeof value !== 'string') {
        throw new SourceStateGateRefusal(
          `${SOURCE_STATE_FIXTURE}: schemaContracts["${factory.semanticId}"].${field} is missing — `
          + 'the pin this gate reads was deleted, which is a louder failure than drift, not a quieter one.',
        )
      }
      stored[field] = value.slice(value.lastIndexOf(':') + 1)
    }
    const live = sourceStateDigest(repoRoot, factory)
    const mismatched = DIGEST_FIELDS.filter(field => stored[field] !== live)

    // P2.235 — the whole string, for every pinned field including the one this
    // gate never read. `handlerSchemaVersion` is absent from some pins by design
    // (only the source-state six carry one), so a missing value is recorded as
    // the empty string and compared like any other mismatch rather than skipped.
    const storedFull = {} as Record<PinField, string>
    const expected = {} as Record<PinField, string>
    for (const field of PIN_FIELDS) {
      storedFull[field] = typeof contract?.[field] === 'string' ? (contract[field] as string) : ''
      expected[field] = expectedPinValue(factory, currentName, live, field, storedFull[field])
    }
    const mismatchedFull = PIN_FIELDS.filter(field => storedFull[field] !== expected[field])

    if (mismatched.length > 0 || mismatchedFull.length > 0) {
      drift.push({
        currentName, semanticId: factory.semanticId, path: factory.path,
        stored, storedFull, expected, live, mismatched, mismatchedFull,
      })
    }
  }
  return drift
}

/**
 * The evidence kinds whose digest is taken over SOURCE TEXT rather than a live
 * import — i.e. the class this gate exists for, the one that goes red on an
 * implementation edit the model never sees.
 *
 * `dynamic-wire-source` belongs here and its omission was a REAL defect in the
 * first version of this file's coverage sentence. Measured on the fixture:
 * `mcp.dynamic` is the single `dynamic-wire-source` row, and the baseline test
 * builds its payload from two `sourceFactoryBlock(...)` regions
 * (`shared/src/mcp/mcp-pool.ts#getProxyToolDefs` and
 * `pi-agent-server/src/index.ts#buildProxyTools`). So it is a source-text
 * change-detector exactly like the six below — a SEVENTH pin of the class that
 * went red for 47 commits — and this gate does not read it. Saying so is the
 * point; the sentence that hid it claimed everything unread was better-derived.
 *
 * P6.877 read it. The paragraph above stood for two rows as an accurate
 * description of a hole nobody closed, which is its own lesson: naming a gap
 * precisely is not the same as shutting it.
 */
export const SOURCE_TEXT_EVIDENCE_KINDS: readonly string[] = ['source-state-schema', 'dynamic-wire-source']

// ---------------------------------------------------------------------------
// P6.877 — the seventh source-text pin, read at last
// ---------------------------------------------------------------------------

/**
 * P6.877 — `mcp.dynamic`, the one pin of this class that was named unread.
 *
 * WHY IT COULD NOT JOIN {@link SOURCE_STATE_FACTORIES}. Every one of the six is
 * ONE region of ONE file hashed under `{ sourcePath, factorySource }`. This pin
 * hashes THREE values from two files — the binding pattern the fixture row
 * carries, plus one region each from the MCP pool's projection and the Pi
 * server's. A generic "regions" field on the factory type would have had to
 * carry per-pin payload KEY NAMES, and the digest must reproduce
 * `pi-harness-baseline.test.ts`'s byte for byte or this gate goes red on a
 * correct fixture. So the payload is spelled out here rather than abstracted,
 * and the two derivations are held together by the test that recomputes the
 * shipped fixture from source text alone.
 *
 * WHY THE DEFAULT PATH AND NOT A FLAG. `--live-json-schema` (P6.818) is opt-in
 * because it costs a 5.7 s dynamic import. This costs two `readFileSync` calls
 * on files the gate is already a change-detector for — measured below at the
 * same order as the six — so putting it behind a flag would be inventing a cost
 * to justify a switch.
 *
 * WHAT IT STILL IS NOT. Like the six, this is a SOURCE-TEXT digest: an edit
 * anywhere inside either region moves it while the model sees nothing new. It
 * is a change-detector on the wire projection, not a model-surface pin.
 */
export const DYNAMIC_WIRE_SOURCE_KIND = 'dynamic-wire-source'

/** One hashed region, keyed by the payload field it becomes. */
export interface DynamicWireSourceRegion {
  /** The payload key — part of the digest, so it is data, not a label. */
  readonly key: string
  readonly path: string
  readonly start: string
  readonly end: string
}

export const DYNAMIC_WIRE_SOURCE_PIN = Object.freeze({
  semanticId: 'mcp.dynamic',
  /** The fixture collection holding this pin's row: its name, pattern and handler. */
  fixtureRow: 'dynamicMcp',
  /** `handlerSchemaVersion`'s path half — the pool, not either region's owner by accident. */
  handlerSource: 'packages/shared/src/mcp/mcp-pool.ts',
  regions: Object.freeze([
    Object.freeze({
      key: 'poolProjection',
      path: 'packages/shared/src/mcp/mcp-pool.ts',
      start: '  getProxyToolDefs(slugs?: string[], leaserId?: string): ProxyToolDef[]',
      // P3 made the callTool signature multi-line (optional per-call context),
      // which is why the end marker stops at the open paren.
      end: '  async callTool(',
    }),
    Object.freeze({
      key: 'piProjection',
      path: 'packages/pi-agent-server/src/index.ts',
      start: 'function buildProxyTools(backgroundTasks?: BackgroundTaskRegistry)',
      end: 'async function queryLlm',
    }),
  ]) as readonly DynamicWireSourceRegion[],
})

/**
 * The semantic ids whose DIGEST this gate recomputes on its default path.
 *
 * Derived, not typed in: the six factories plus the dynamic-wire pin. Every
 * coverage sentence and the unread list read this rather than
 * {@link SOURCE_STATE_FACTORY_SEMANTIC_IDS}, so adding a pin here cannot leave a
 * sentence behind claiming it is unread — the shape P2.235(d) was fixed for.
 */
export const SOURCE_STATE_COVERED_SEMANTIC_IDS: readonly string[] = [
  ...SOURCE_STATE_FACTORY_SEMANTIC_IDS,
  DYNAMIC_WIRE_SOURCE_PIN.semanticId,
]

/**
 * The exact payload the digest is taken over — the same three keys, in the same
 * canonicalisation, as `pi-harness-baseline.test.ts`'s `dynamicMcp` contract.
 */
export function dynamicWireSourcePayload(repoRoot: string, bindingPattern: string): Record<string, string> {
  const payload: Record<string, string> = { bindingPattern }
  for (const region of DYNAMIC_WIRE_SOURCE_PIN.regions) {
    payload[region.key] = sourceStateFactoryBlock(repoRoot, {
      path: region.path,
      start: region.start,
      end: region.end,
      semanticId: DYNAMIC_WIRE_SOURCE_PIN.semanticId,
    })
  }
  return payload
}

/** PURE, so a planted change in one field can be shown to move the digest. */
export function dynamicWireSourcePayloadDigest(payload: Readonly<Record<string, string>>): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

/** The whole value each pinned field must carry for the dynamic-wire pin. */
export function expectedDynamicWirePinValue(
  row: { readonly currentName: string; readonly handlerName: string },
  digest: string,
  field: PinField,
  stored: string,
): string {
  switch (field) {
    case 'schemaIdentity': return `${DYNAMIC_WIRE_SOURCE_KIND}:sha256:${digest}`
    case 'modelSchemaVersion': return `${DYNAMIC_WIRE_SOURCE_KIND}/sha256:${digest}`
    case 'bindingSchemaVersion': return `exact-name:${row.currentName}/sha256:${digest}`
    case 'handlerSchemaVersion': {
      // Same treatment as the six: the `@<commit>` half is carried, not derived,
      // and a pin without one says so rather than having one invented for it.
      const commit = HANDLER_COMMIT.exec(stored)?.[0] ?? '@<40-hex commit missing from the pin>'
      return `${DYNAMIC_WIRE_SOURCE_PIN.handlerSource}#${row.handlerName}${commit}`
    }
  }
}

/**
 * The dynamic-wire pin's drift, in the SAME {@link SourceStateDrift} shape as the
 * six — so the drift report, the hand-edit split and `--pin` all reach it with
 * no second copy of any of them.
 *
 * A MISSING pin refuses rather than returning nothing. "No pin, no finding" is
 * how an absence reads as coverage, which is the failure this file keeps being
 * fixed for; the six behave the same way for a missing field.
 */
export function collectDynamicWireSourceDrift(repoRoot: string): SourceStateDrift[] {
  const fixture = JSON.parse(readFileSync(resolve(repoRoot, SOURCE_STATE_FIXTURE), 'utf8')) as {
    schemaContracts?: Record<string, Record<string, string>>
    dynamicMcp?: Record<string, string>
  }
  const { semanticId, fixtureRow } = DYNAMIC_WIRE_SOURCE_PIN
  const contract = fixture.schemaContracts?.[semanticId]
  if (!contract) {
    throw new SourceStateGateRefusal(
      `${SOURCE_STATE_FIXTURE}: schemaContracts["${semanticId}"] is missing — the seventh source-text `
      + 'pin this gate reads was deleted. That is a louder failure than drift, not a quieter one.',
    )
  }
  const row = (fixture as Record<string, unknown>)[fixtureRow] as Record<string, string> | undefined
  for (const field of ['currentName', 'bindingPattern', 'handlerName'] as const) {
    if (typeof row?.[field] !== 'string') {
      throw new SourceStateGateRefusal(
        `${SOURCE_STATE_FIXTURE}: ${fixtureRow}.${field} is missing, so ${semanticId}'s payload and `
        + 'prefixes cannot be derived. Restore the row rather than dropping the pin.',
      )
    }
  }
  const live = dynamicWireSourcePayloadDigest(dynamicWireSourcePayload(repoRoot, row!.bindingPattern!))
  const stored = {} as Record<DigestField, string>
  for (const field of DIGEST_FIELDS) {
    const value = contract[field]
    if (typeof value !== 'string') {
      throw new SourceStateGateRefusal(
        `${SOURCE_STATE_FIXTURE}: schemaContracts["${semanticId}"].${field} is missing — `
        + 'the pin this gate reads was deleted, which is a louder failure than drift, not a quieter one.',
      )
    }
    stored[field] = value.slice(value.lastIndexOf(':') + 1)
  }
  const storedFull = {} as Record<PinField, string>
  const expected = {} as Record<PinField, string>
  for (const field of PIN_FIELDS) {
    storedFull[field] = typeof contract[field] === 'string' ? contract[field] : ''
    expected[field] = expectedDynamicWirePinValue(
      { currentName: row!.currentName!, handlerName: row!.handlerName! },
      live,
      field,
      storedFull[field],
    )
  }
  const mismatched = DIGEST_FIELDS.filter(field => stored[field] !== live)
  const mismatchedFull = PIN_FIELDS.filter(field => storedFull[field] !== expected[field])
  if (mismatched.length === 0 && mismatchedFull.length === 0) return []
  return [{
    currentName: row!.currentName!,
    semanticId,
    // Both regions, because a report naming one of two files sends the reader to
    // the wrong half of the pin exactly half the time.
    path: DYNAMIC_WIRE_SOURCE_PIN.regions.map(region => `${region.path}#${region.start.trim()}`).join(' + '),
    stored, storedFull, expected, live, mismatched, mismatchedFull,
  }]
}

/**
 * P6.877 — the planted-region check, PURE, in the shape {@link liveJsonSchemaSelfCheckFailure}
 * uses: a comparator that has never moved is not known to move.
 *
 * The hazard it is against is specific. The payload has three fields and two of
 * them are whole file regions; an end marker that drifted so a region came back
 * identical for every input, or a payload that quietly stopped carrying one of
 * them, leaves a digest that still LOOKS like a change-detector and detects half
 * as much. So each field is planted in turn and each must move the digest.
 */
export function dynamicWireSourceSelfCheckFailure(): string | null {
  const base: Record<string, string> = {
    bindingPattern: 'mcp__server__tool',
    ...Object.fromEntries(DYNAMIC_WIRE_SOURCE_PIN.regions.map(region => [region.key, `region ${region.key}`])),
  }
  const digest = dynamicWireSourcePayloadDigest(base)
  for (const key of Object.keys(base)) {
    if (dynamicWireSourcePayloadDigest({ ...base, [key]: `${base[key]!}// planted` }) !== digest) continue
    return `a planted change in ${key} does not move the dynamic-wire digest, so that half of the `
      + `${DYNAMIC_WIRE_SOURCE_PIN.semanticId} payload is no longer covered by the pin at all.`
  }
  const identity = expectedDynamicWirePinValue({ currentName: 'a', handlerName: 'h' }, digest, 'schemaIdentity', '')
  if (!identity.startsWith(`${DYNAMIC_WIRE_SOURCE_KIND}:`)) {
    return `the dynamic-wire pin derives ${JSON.stringify(identity)}, which does not carry its own `
      + `evidence kind — the prefix is what tells this pin's class from the six source-state ones.`
  }
  return null
}

export interface SchemaContractCensus {
  readonly total: number
  /** Pins whose digest comes from source text, whether or not this gate reads them. */
  readonly sourceText: readonly string[]
  /** Pins whose digest comes from a live import — never readable without the Pi runtime graph. */
  readonly liveDerived: readonly string[]
}

/** What the fixture actually holds, counted rather than claimed. */
export function censusSchemaContracts(repoRoot: string): SchemaContractCensus {
  const fixture = JSON.parse(readFileSync(resolve(repoRoot, SOURCE_STATE_FIXTURE), 'utf8')) as {
    schemaContracts?: Record<string, { evidenceKind?: string }>
  }
  const entries = Object.entries(fixture.schemaContracts ?? {})
  const sourceText = entries.filter(([, c]) => SOURCE_TEXT_EVIDENCE_KINDS.includes(c?.evidenceKind ?? '')).map(([id]) => id)
  const liveDerived = entries.filter(([, c]) => !SOURCE_TEXT_EVIDENCE_KINDS.includes(c?.evidenceKind ?? '')).map(([id]) => id)
  return { total: entries.length, sourceText, liveDerived }
}

/**
 * Whether one pin's `evidenceKind` is the subset `--live-json-schema` recomputes.
 * Read from the fixture rather than assumed from the collection: the two agree
 * today (60 = 60, measured 2026-09-08) and a coverage sentence that ASSUMED they
 * always would is the shape this file keeps being fixed for.
 */
function liveJsonSchemaKindOf(repoRoot: string, semanticId: string): boolean {
  const fixture = JSON.parse(readFileSync(resolve(repoRoot, SOURCE_STATE_FIXTURE), 'utf8')) as {
    schemaContracts?: Record<string, { evidenceKind?: string }>
  }
  return (fixture.schemaContracts?.[semanticId]?.evidenceKind ?? '') === LIVE_JSON_SCHEMA_KIND
}

/** How many pins the fixture holds in total — this gate reads only six of them. */
export function countSchemaContracts(repoRoot: string): number {
  return censusSchemaContracts(repoRoot).total
}

/**
 * Rewrites the three digest-bearing fields of one drifted pin. Deliberately
 * behind an explicit `--pin`: the failure has to be READ before it is silenced,
 * because "re-pinned as a side effect" is how the six-commit instance ended.
 */
export function rewritePin(repoRoot: string, drift: SourceStateDrift): void {
  const path = resolve(repoRoot, SOURCE_STATE_FIXTURE)
  if (pinIsInternallyInconsistent(drift)) {
    throw new SourceStateGateRefusal(
      `${SOURCE_STATE_FIXTURE}: the three ${drift.semanticId} fields carry DIFFERENT digests `
      + `(${DIGEST_FIELDS.map(field => `${field}=${drift.stored[field].slice(0, 12)}…`).join(', ')}). `
      + 'That is a hand-edit, not drift, and a blind rewrite would silently pick one of them. '
      + 'Make all three agree by hand, then re-run.',
    )
  }
  // P2.235 — the WHOLE value of each field is replaced, not the hex inside it.
  // Replacing the hex alone is what manufactured the stale-prefix state this gate
  // then reported green: rename a tool and `exact-name:<old name>` survives a
  // `--pin` while every digest agrees.
  let text = readFileSync(path, 'utf8')
  for (const field of PIN_FIELDS) {
    const stored = drift.storedFull[field]
    const want = drift.expected[field]
    if (stored === want) continue
    if (stored === '') {
      throw new SourceStateGateRefusal(
        `${SOURCE_STATE_FIXTURE}: ${drift.semanticId}.${field} is absent, so there is nothing to rewrite `
        + 'in place. Add the field by hand — a rewrite that INVENTED it would be writing a pin nobody chose.',
      )
    }
    const occurrences = text.split(stored).length - 1
    if (occurrences !== 1) {
      throw new SourceStateGateRefusal(
        `${SOURCE_STATE_FIXTURE}: expected ${drift.semanticId}.${field}'s value exactly once but found `
        + `${occurrences}. Re-pin by hand rather than letting this rewrite guess which one it meant.`,
      )
    }
    text = text.split(stored).join(want)
  }
  writeFileSync(path, text)
}

/**
 * I2 — printed on BOTH paths. It used to print only when green, which put the
 * gate's own limit on the one output nobody has a reason to read: this row's
 * whole thesis, committed inside the fix for it.
 */
export function coverageLine(repoRoot: string, covered: number): string {
  const census = censusSchemaContracts(repoRoot)
  const unread = unreadSemanticIds(repoRoot)
  const unreadSourceTextNames = census.sourceText.filter(id => !SOURCE_STATE_COVERED_SEMANTIC_IDS.includes(id))
  const liveJsonSchema = census.liveDerived.filter(id => liveJsonSchemaKindOf(repoRoot, id)).length
  const lines = [
    `  Coverage: ${covered} of ${census.total} schemaContracts, stated the way that flatters this`,
    `  gate LEAST. Of the ${unread.length} it does NOT read, ${census.liveDerived.length} are live-derived digests`,
    `  (live-json-schema + live-tool-parameters) — while the ${covered} it DOES read are source-text`,
    '  digests, i.e. not model-surface pins at all.',
  ]
  // P6.818 — this paragraph used to end "cannot be checked without pulling the Pi
  // runtime graph into a typecheck", which was true of the whole live-derived
  // population only until somebody measured the halves separately. Splitting it is
  // the point of the row: the half that costs seconds now has a mode, and a
  // coverage sentence that kept calling it unreachable would be the same
  // over-claim in the other direction.
  if (liveJsonSchema > 0) {
    lines.push(
      `  P6.818 — ${liveJsonSchema} of those live-derived pins are \`live-json-schema\`, and they need only`,
      '  `getToolDefsAsJsonSchema` (seconds), not the Pi runtime graph (336 s of imports, measured).',
      '  Recomputed on demand, opt-in so this default path pays nothing for them:',
      '    bun run --cwd packages/pi-agent-server check:surface -- --live-json-schema',
      `  The ${census.liveDerived.length - liveJsonSchema} \`live-tool-parameters\` pins DO need that graph and stay root-\`bun test\` only.`,
    )
  }
  if (unreadSourceTextNames.length > 0) {
    // P2.235(d) — COUNTED, not subtracted. This number used to be
    // `census.sourceText.length − covered`, so relabelling the `evidenceKind` of a
    // COVERED pin — a field the gate never reads — made the whole sentence below
    // vanish while `mcp.dynamic` stayed unread. It is now the length of the very
    // list it prints, which cannot disagree with itself, and the singular/plural
    // follows it instead of assuming one.
    const count = unreadSourceTextNames.length
    lines.push(
      `  The remaining ${count} unread (${unreadSourceTextNames.join(', ')}) ${count === 1 ? 'is' : 'are'} NOT live-derived: `
        + `${count === 1 ? 'it is a source-text' : 'they are source-text'}`,
      `  ${count === 1 ? 'digest' : 'digests'} of the SAME class as these six, so the class that went red for 47 commits still`,
      `  has ${count === 1 ? 'a member' : 'members'} this gate does not read.`,
    )
  }
  lines.push('  Everything unread is asserted only by pi-harness-baseline.test.ts, under root `bun test`.')
  lines.push(...modelContractPointerLines())
  return lines.join('\n')
}

/**
 * UB12.14 (2026-10-16) — the command that DOES compare the model-contract pins,
 * printed by the gate that does not.
 *
 * `PI_STATIC_MODEL_CONTRACT_HASHES` are not `schemaContracts`, so the census
 * above never counts them, and this path compares none of them against a live
 * projection (`--pin` does, for the drift it is about to silence). A new or
 * renamed SESSION tool can move one without touching any pinned file: its
 * spelling joins `PI_TOOL_PRESENTATION_REWRITES` and rewrites a pinned static
 * tool's text. UB6.11 (`c9a724544`) shipped exactly that — `decide` turned
 * `ask_user`'s snippet into a tool name and every Pi session carrying `ask_user`
 * died on its first turn (fixed in UB12.5, `8eedd1657`) — while this gate, the
 * last command of the Session-tools recipe, read green.
 *
 * WHY A POINTER AND NOT THE TEST ITSELF. Running the test from here is the shape
 * D1.1 (2026-09-17, `scripts/check-surface-selftest.ts`) refuses: this gate
 * rides `bun run typecheck`, and attaching a test runner to it either serialises
 * every lane on the advisory `bun test` lock or runs unsynchronised `bun test`
 * processes; the live Pi tool graph the test imports is the cost P6.1077 keeps
 * off this path. So the test belongs in the Session-tools recipe itself (UB12.14
 * proposes that amendment to the plan's Global Constraints), and this gate prints
 * it on BOTH paths, where the lane running the recipe reads — asserted as I4 by
 * {@link describeReportShapeFailure}.
 */
export const MODEL_CONTRACT_TEST_COMMAND =
  'bun scripts/bun-test-lock.ts run --label <lane> -- bun test ./packages/pi-agent-server/src/harness/live-manifest-contract.test.ts'

/** The I4 lines, PURE: one source for the report and for the self-check's needle. */
export function modelContractPointerLines(): string[] {
  return [
    '  NOT COMPARED HERE: PI_STATIC_MODEL_CONTRACT_HASHES, the model-contract pins a Pi first turn',
    '  enforces. A new or renamed session tool can move one through PI_TOOL_PRESENTATION_REWRITES',
    '  without touching a pinned file (UB6.11 did, for ask_user). After touching the session-tools',
    '  set or a Pi tool\'s model-facing text, run from the repo root (UB12.14):',
    `    ${MODEL_CONTRACT_TEST_COMMAND}`,
  ]
}

/**
 * P2.235 — the uncovered pins BY NAME.
 *
 * The row's headline is "six of seventy-seven", and a bare count is exactly the
 * artefact this file keeps being fixed for: the fixture holds **78** pins today,
 * not 77, and no prose noticed. Naming them makes the coverage claim derived
 * rather than restated, and makes the list itself the thing a reader checks.
 */
export function unreadSemanticIds(repoRoot: string): string[] {
  const census = censusSchemaContracts(repoRoot)
  return [...census.sourceText, ...census.liveDerived]
    .filter(id => !SOURCE_STATE_COVERED_SEMANTIC_IDS.includes(id))
    .sort()
}

// ---------------------------------------------------------------------------
// P2.235 — the STRUCTURE of every pin, all 78, at no runtime-graph cost
// ---------------------------------------------------------------------------

/**
 * The half of "the digest gate over all 78 pins" that needs no Pi runtime graph,
 * and therefore rides the same `bun run typecheck` the six-pin digest check does.
 *
 * WHAT THE DIGEST HALF COSTS, AND WHY IT IS NOT WIDENED HERE. The other 72 pins
 * are live-derived (`live-json-schema`, `live-tool-parameters`), so recomputing
 * their digests means importing the live Pi tool graph inside this gate.
 * Measured 2026-09-03 (W3-h, load 17.5): those imports cost **336 145 ms** —
 * `runtime-backed-tools.ts` 132 389 ms and `subagent-tool.ts` 105 473 ms alone —
 * against this gate's current sub-second run. Five and a half minutes on every
 * lane's affected-package typecheck is not a trade this row asked for, and the
 * live recompute of all 78 already exists at `bun test` time
 * (`pi-harness-baseline.test.ts` compares the whole `schemaContracts` object
 * against freshly derived contracts).
 *
 * WHAT IS WIDENED, AND WHY IT IS THE PART THAT MATTERS. Every hazard this row
 * catalogued is a property of the STORED STRINGS plus the filesystem, not of the
 * digest value:
 *
 *   - a right digest under a corrupted PREFIX (`source-state-schema:` vs `/` vs
 *     `exact-name:<tool>/`) — and `--pin` MANUFACTURES that state, because it
 *     rewrote only the hex while the tool's name sits inside the hashed block;
 *   - the three digest fields disagreeing with each other, which is a hand-edit
 *     rather than drift;
 *   - `handlerSchemaVersion` naming a file or a handler that no longer exists.
 *
 * All three were checked for six pins and unchecked for seventy-two. They are
 * now checked for all 78, by deriving each field from the fixture's OWN row
 * (`sessionTools` / `piStaticTools` / `conditionalTools` / `dynamicMcp`) rather
 * than restating it — so a renamed tool whose contract kept the old
 * `exact-name:` is a finding on any of the 78, not only on the six.
 *
 * Measured at the commit this was written on: 78 contracts, 78 rows, zero
 * findings — so it is a guard over a state that already holds, not a backlog.
 */
export interface PinRow {
  readonly semanticId: string
  readonly currentName: string
  readonly handlerName: string
  /** Which fixture collection the row came from, for the message. */
  readonly collection: string
}

/** The row collections that back a `schemaContracts` entry, in fixture order. */
const PIN_ROW_COLLECTIONS = ['sessionTools', 'piStaticTools', 'conditionalTools'] as const

export function readPinRows(repoRoot: string): Map<string, PinRow> {
  const fixture = JSON.parse(readFileSync(resolve(repoRoot, SOURCE_STATE_FIXTURE), 'utf8')) as Record<string, unknown>
  const rows = new Map<string, PinRow>()
  const admit = (entry: unknown, collection: string): void => {
    const row = entry as Partial<PinRow> | null
    if (!row || typeof row.semanticId !== 'string') return
    rows.set(row.semanticId, {
      semanticId: row.semanticId,
      currentName: typeof row.currentName === 'string' ? row.currentName : '',
      handlerName: typeof row.handlerName === 'string' ? row.handlerName : '',
      collection,
    })
  }
  for (const collection of PIN_ROW_COLLECTIONS) {
    const list = fixture[collection]
    if (!Array.isArray(list)) continue
    for (const entry of list) admit(entry, collection)
  }
  // `dynamicMcp` is a single object, not a list — which is exactly why the pin it
  // backs (`mcp.dynamic`) was the seventh source-text pin nobody was reading.
  admit(fixture.dynamicMcp, 'dynamicMcp')
  return rows
}

export interface PinStructureFinding {
  readonly semanticId: string
  readonly field: string
  readonly stored: string
  readonly expected: string
  readonly why: string
}

const SHA256_HEX = /^[0-9a-f]{64}$/
const HANDLER_SHAPE = /^([^#]+)#([^@]+)@([0-9a-f]{40})$/

export function collectPinStructureFindings(repoRoot: string): PinStructureFinding[] {
  const fixture = JSON.parse(readFileSync(resolve(repoRoot, SOURCE_STATE_FIXTURE), 'utf8')) as {
    schemaContracts?: Record<string, Record<string, string>>
  }
  return findPinStructureFindings(
    fixture.schemaContracts ?? {},
    readPinRows(repoRoot),
    path => existsSync(resolve(repoRoot, path)),
  )
}

/**
 * The rule itself, over parsed data and an existence predicate.
 *
 * PURE on purpose — P2.255. The test of this checker rides root `bun test`,
 * which no lane runs in an implementation loop, so the CLI drives this function
 * over a synthetic corrupted pin before it trusts it on the real fixture
 * ({@link structureSelfCheckFailure}). A checker that cannot be shown to fire is
 * indistinguishable from one whose branches were deleted, and that has to be
 * demonstrable on the command a lane really runs.
 */
export function findPinStructureFindings(
  schemaContracts: Readonly<Record<string, Record<string, string>>>,
  rows: ReadonlyMap<string, PinRow>,
  fileExists: (path: string) => boolean,
): PinStructureFinding[] {
  const contracts = Object.entries(schemaContracts)
  const findings: PinStructureFinding[] = []
  const add = (semanticId: string, field: string, stored: string, expected: string, why: string): void => {
    findings.push({ semanticId, field, stored: stored || '(absent)', expected, why })
  }

  for (const [semanticId, contract] of contracts) {
    const row = rows.get(semanticId)
    if (!row) {
      add(semanticId, '(row)', '', `a row in one of ${[...PIN_ROW_COLLECTIONS, 'dynamicMcp'].join(', ')}`,
        'a pin with no row is a pin nothing can derive its own name or handler from.')
      continue
    }
    const evidenceKind = contract.evidenceKind ?? ''
    const identity = contract.schemaIdentity ?? ''
    const prefix = `${evidenceKind}:sha256:`
    if (evidenceKind.length === 0 || !identity.startsWith(prefix) || !SHA256_HEX.test(identity.slice(prefix.length))) {
      add(semanticId, 'schemaIdentity', identity, `${prefix}<64 hex>`,
        'schemaIdentity carries the evidenceKind, so a mismatch here means the pin claims one provenance and states another.')
      continue
    }
    const digest = identity.slice(prefix.length)
    const expected: Record<string, string> = {
      modelSchemaVersion: `${evidenceKind}/sha256:${digest}`,
      bindingSchemaVersion: `exact-name:${row.currentName}/sha256:${digest}`,
    }
    for (const [field, want] of Object.entries(expected)) {
      const stored = contract[field] ?? ''
      if (stored === want) continue
      add(semanticId, field, stored, want,
        field === 'bindingSchemaVersion'
          ? `the name inside exact-name: is hashed INTO the digest, so --pin rewriting only the hex leaves a stale name here — ${row.collection} says the tool is now "${row.currentName}".`
          : 'the three digest fields must agree with each other; a disagreement is a hand-edit, not drift.')
    }
    const handler = contract.handlerSchemaVersion ?? ''
    const shape = HANDLER_SHAPE.exec(handler)
    if (!shape) {
      add(semanticId, 'handlerSchemaVersion', handler, '<repo-relative path>#<handlerName>@<40 hex commit>',
        'the field nothing read until this row; its shape is what makes the path and handler below checkable at all.')
      continue
    }
    const [, handlerPath, handlerName] = shape
    if (handlerName !== row.handlerName) {
      add(semanticId, 'handlerSchemaVersion', handler, `…#${row.handlerName}@…`,
        `${row.collection} names the handler "${row.handlerName}"; the pin names another, so one of the two is stale.`)
    }
    if (!fileExists(handlerPath ?? '')) {
      add(semanticId, 'handlerSchemaVersion', handler, `a path that exists (${handlerPath} does not)`,
        'a pin naming a file that was moved or deleted points every reader at nothing.')
    }
  }

  // Completeness the other way: a row with no pin is a tool whose contract is
  // recorded nowhere, which reads as coverage rather than as the gap it is.
  for (const [semanticId, row] of rows) {
    if (schemaContracts[semanticId]) continue
    add(semanticId, '(contract)', '', 'a schemaContracts entry',
      `${row.collection} carries this tool and no pin does, so nothing detects a change to it.`)
  }
  return findings
}

/**
 * P2.255 — the structure checker proving it can go RED, on the command lanes run.
 *
 * The report-shape self-check above moved one half of "the test of the gate
 * rides a command nobody runs" onto the fast path. This is the other half for
 * the check added by P2.235: three synthetic pins, each corrupted in one of the
 * three ways the rule exists to catch, plus a clean control that must produce
 * nothing. It costs no file I/O — the rule is pure, and the existence predicate
 * is a closure — so it runs on every `bun run typecheck` in this package.
 *
 * It does NOT close the seam. The synthetic-repo cases in
 * `source-state-contract.test.ts` still ride root `bun test`; this only makes a
 * deletion of the rule's branches fail the command a lane is guaranteed to run,
 * rather than waiting for merge.
 */
export function structureSelfCheckFailure(): string | null {
  const digest = 'a'.repeat(64)
  const commit = 'b'.repeat(40)
  const clean = (name: string, handler: string): Record<string, string> => ({
    evidenceKind: 'live-json-schema',
    schemaIdentity: `live-json-schema:sha256:${digest}`,
    modelSchemaVersion: `live-json-schema/sha256:${digest}`,
    bindingSchemaVersion: `exact-name:${name}/sha256:${digest}`,
    handlerSchemaVersion: `packages/present.ts#${handler}@${commit}`,
  })
  const rows = new Map<string, PinRow>([
    ['ok', { semanticId: 'ok', currentName: 'tool_ok', handlerName: 'handlerOk', collection: 'synthetic' }],
    ['stale', { semanticId: 'stale', currentName: 'tool_new', handlerName: 'handlerOk', collection: 'synthetic' }],
    ['handler', { semanticId: 'handler', currentName: 'tool_ok', handlerName: 'handlerOk', collection: 'synthetic' }],
    ['kind', { semanticId: 'kind', currentName: 'tool_ok', handlerName: 'handlerOk', collection: 'synthetic' }],
  ])
  const contracts: Record<string, Record<string, string>> = {
    ok: clean('tool_ok', 'handlerOk'),
    // the `--pin` shape: right hex, yesterday's name
    stale: clean('tool_old', 'handlerOk'),
    // a handler the row does not name
    handler: clean('tool_ok', 'handlerGone'),
    // an evidenceKind that disagrees with its own schemaIdentity prefix
    kind: { ...clean('tool_ok', 'handlerOk'), evidenceKind: 'source-state-schema' },
  }
  const caught = new Set(
    findPinStructureFindings(contracts, rows, path => path === 'packages/present.ts')
      .map(finding => finding.semanticId),
  )
  const missed = ['stale', 'handler', 'kind'].filter(id => !caught.has(id))
  if (missed.length > 0) {
    return `the pin-structure rule no longer catches ${missed.join(', ')} — P2.235's three hazards, `
      + 'and a rule that cannot go red for them is the state --pin used to manufacture and this gate '
      + 'used to report green.'
  }
  if (caught.has('ok')) {
    return 'the pin-structure rule reports a finding against a pin that agrees with its own row — it '
      + 'would fire on every correct fixture, which is how a gate gets switched off.'
  }
  // The path predicate has to be READ, or "the file exists" would be assumed and
  // the moved-handler class would never fire on a real tree either. ONE row and
  // ONE contract: passing the whole row map made the completeness rule supply
  // findings of its own, and this probe then survived a mutant that disabled the
  // predicate outright — a control that could not fail, caught by running it.
  const blind = findPinStructureFindings(
    { ok: contracts.ok! },
    new Map([['ok', rows.get('ok')!]]),
    () => false,
  )
  if (blind.length === 0) {
    return 'the pin-structure rule ignores its file-existence predicate, so a handlerSchemaVersion '
      + 'naming a deleted file would pass.'
  }
  return null
}

/** How many pins the structural half reads — printed beside the digest half's six. */
export function structureCoverageLine(repoRoot: string): string {
  const total = censusSchemaContracts(repoRoot).total
  const rows = readPinRows(repoRoot).size
  return `  Structure: ${total} of ${total} schemaContracts checked against their own fixture rows `
    + `(${rows} rows) — prefixes, cross-field digest agreement, handler path and handler name. The `
    + `${DIGEST_FIELDS.length} DIGEST VALUES are recomputed for `
    + `${SOURCE_STATE_COVERED_SEMANTIC_IDS.length} of them here, for the live-json-schema subset under `
    + '`check:surface -- --live-json-schema` (P6.818); the rest need the live Pi tool graph '
    + '(336 s of imports, measured) and are recomputed by pi-harness-baseline.test.ts under root `bun test`.'
}

/** The structural report, as data, so its shape can be pinned like the drift one. */
export function renderPinStructureReport(findings: readonly PinStructureFinding[]): string[] {
  const lines: string[] = ['']
  lines.push('PIN STRUCTURE — a pinned field does not agree with the fixture row it belongs to.')
  lines.push('This is NOT a digest mismatch: the hash may be right and the prefix, name or handler wrong,')
  lines.push('which is the state `--pin` used to manufacture and this gate used to report green.')
  lines.push('')
  for (const finding of findings) {
    lines.push(`  ${finding.semanticId} · ${finding.field}`)
    lines.push(`    stored:   ${finding.stored}`)
    lines.push(`    expected: ${finding.expected}`)
    lines.push(`    why:      ${finding.why}`)
  }
  lines.push('')
  lines.push(`  Fix by hand in ${SOURCE_STATE_FIXTURE} — --pin rewrites digest-bearing fields only and`)
  lines.push('  cannot repair a name or a handler it has no way to know was renamed.')
  lines.push('')
  return lines
}

/**
 * The whole red-path report as DATA, so the invariants it carries can be pinned
 * by a test instead of by a scratchpad campaign CI never runs. F1/F2/I1/I2 all
 * live in these strings; a shipped test asserts them.
 */
export function renderDriftReport(repoRoot: string, drift: readonly SourceStateDrift[], covered: number): string[] {
  const lines: string[] = ['']
  lines.push('SOURCE-STATE CONTRACT DRIFT — a pinned FACTORY SOURCE no longer matches the file it')
  lines.push('was taken from. This is NOT by itself a model-facing change; see below.')
  lines.push('')
  for (const row of drift) {
    lines.push(`  ${row.semanticId} (${row.currentName})`)
    lines.push(`    factory: ${row.path}`)
    lines.push(`    live:    ${row.live}`)
    for (const field of DIGEST_FIELDS) {
      lines.push(`    ${row.stored[field] === row.live ? 'ok   ' : 'DRIFT'} ${field}: ${row.stored[field]}`)
    }
    // P2.235 — the prefixes, which the three lines above throw away. A right
    // digest under a corrupted prefix used to print as three `ok` lines.
    for (const field of PIN_FIELDS) {
      if (row.storedFull[field] === row.expected[field]) continue
      lines.push(`    PREFIX/VALUE ${field}:`)
      lines.push(`      stored:   ${row.storedFull[field] || '(absent)'}`)
      lines.push(`      expected: ${row.expected[field]}`)
    }
    if (pinIsInternallyInconsistent(row)) {
      lines.push('    ^^ the three fields DISAGREE WITH EACH OTHER, so this pin was hand-edited,')
      lines.push('       not drifted. --pin refuses it; make them agree by hand first.')
    }
  }
  lines.push('')
  lines.push(coverageLine(repoRoot, covered))
  lines.push(structureCoverageLine(repoRoot))
  lines.push('')
  // P2.235 — the uncovered pins BY NAME rather than as a count, so "six of
  // seventy-seven" cannot go on being repeated while the fixture holds 78.
  const unread = unreadSemanticIds(repoRoot)
  lines.push(`  The ${unread.length} pins this gate does NOT read, named:`)
  for (let index = 0; index < unread.length; index += 4) {
    lines.push(`    ${unread.slice(index, index + 4).join('  ')}`)
  }
  lines.push('')
  lines.push(`  The pin lives in ${SOURCE_STATE_FIXTURE}`)
  lines.push('  and is asserted by "pins deterministic production schema contracts for every effective tool"')
  lines.push('  in packages/pi-agent-server/src/__tests__/harness-contract/pi-harness-baseline.test.ts.')
  lines.push('')
  lines.push('  This digest covers the WHOLE factory, implementation included, so an edit inside')
  lines.push('  execute() moves it without moving anything the model sees. Before re-pinning, decide')
  lines.push('  which of the two happened:')
  lines.push('    - model-facing declaration moved (name/description/promptSnippet/guidelines/parameters)')
  lines.push('      -> PI_STATIC_MODEL_CONTRACT_HASHES in')
  lines.push('         packages/shared/src/agent/pi-harness/harness-tool-descriptor.ts must move too, and')
  lines.push('         src/harness/live-manifest-contract.test.ts is what proves it;')
  lines.push('    - implementation only -> that pin correctly stays put and only this one moves.')
  lines.push('')
  lines.push('  Then re-pin deliberately:')
  lines.push('    bun run --cwd packages/pi-agent-server check:surface -- --pin')
  lines.push('')
  return lines
}

/** The green-path report, same treatment and the same coverage sentence. */
export function renderGreenReport(repoRoot: string, covered: number): string[] {
  return [
    `source-state contract pins: ${covered}/${covered} match live source, all `
      + `${DIGEST_FIELDS.length} digest fields each.`,
    coverageLine(repoRoot, covered),
    structureCoverageLine(repoRoot),
  ]
}

/**
 * P2.255 — the gate rides `bun run typecheck` and the TEST of the gate rides
 * root `bun test`, which no lane runs in an implementation loop. So I1/I2/I3
 * are protected only at merge, and a lane can narrow this file's reports back
 * to the shape they were written to remove and stay green locally.
 *
 * The row's own reviewer named the mitigation and this is it, unchanged in
 * scope: {@link renderDriftReport} and {@link renderGreenReport} are PURE, so
 * the CLI can assert on its own rendered output BEFORE printing it — on the
 * command every lane already runs, at no measurable cost.
 *
 * The synthetic row below is why this is cheap: the invariants are properties
 * of the RENDERER, not of the repository, so nothing has to be drifted to
 * exercise the red path. `coverageLine` reads the fixture that
 * `collectSourceStateDrift` has already read.
 *
 * WHAT THIS DOES NOT CLOSE, said plainly so nobody reads it as more than it is.
 * The test of the CHECKER — the synthetic-repo cases in
 * `source-state-contract.test.ts` covering drift detection, the hand-edit
 * split, the per-field refusals and `--pin` — still rides `bun test`. This
 * moves only the report-shape half onto the fast path. The larger policy
 * question the row poses (which command is a lane GUARANTEED to run, and can
 * anything be attached to it without dragging in the `bun test` mutex) is
 * untouched, and is still to be decided with P2.222 and P2.233.
 */
export function reportShapeSelfCheckFailure(repoRoot: string, covered: number): string | null {
  const digest = (fill: string): string => fill.repeat(64)
  const synthetic: SourceStateDrift = {
    currentName: '(self-check)',
    semanticId: '(self-check)',
    path: '(self-check)',
    stored: Object.fromEntries(DIGEST_FIELDS.map(field => [field, digest('a')])) as Record<DigestField, string>,
    storedFull: Object.fromEntries(PIN_FIELDS.map(field => [field, `(self-check stored ${field})`])) as Record<PinField, string>,
    expected: Object.fromEntries(PIN_FIELDS.map(field => [field, `(self-check expected ${field})`])) as Record<PinField, string>,
    live: digest('b'),
    mismatched: [...DIGEST_FIELDS],
    mismatchedFull: [...PIN_FIELDS],
  }
  return describeReportShapeFailure(
    renderDriftReport(repoRoot, [synthetic], covered).join('\n'),
    renderGreenReport(repoRoot, covered).join('\n'),
  )
}

/**
 * The invariants themselves, over the two rendered strings and nothing else.
 *
 * Split out so the check can be driven in BOTH directions by a test: a
 * self-check that can only be exercised on output that already satisfies it is
 * indistinguishable from one whose branches were deleted.
 */
export function describeReportShapeFailure(red: string, green: string): string | null {
  // I1 — the headline must not assert the misconception the row exists to kill.
  if (!red.includes('pinned FACTORY SOURCE')) {
    return 'the drift report no longer says "pinned FACTORY SOURCE" — I1, the headline that keeps a source digest from reading as a model-facing change.'
  }
  if (red.includes('model-facing tool surface')) {
    return 'the drift report claims a "model-facing tool surface" — I1 inverted; this digest covers the whole factory, implementation included.'
  }
  // I2 — the coverage caveat has to be on the path a lane actually reads, which
  // is the RED one. It was green-only once, and that was the row's own defect.
  for (const [label, text] of [['red', red], ['green', green]] as const) {
    if (!text.includes('Coverage:') || !text.includes('schemaContracts')) {
      return `the ${label}-path report dropped the coverage caveat — I2; it states how few of the fixture's pins this gate reads, and a report without it overstates the gate.`
    }
    // P2.235's half of the same caveat: the DIGEST half reads six, the
    // STRUCTURAL half reads all of them, and a report that prints one number
    // without the other is the "6 of 78" headline this file keeps being fixed for.
    if (!text.includes('Structure:')) {
      return `the ${label}-path report dropped the structure line — I2; without it the coverage sentence reads as if the gate touched six pins in total.`
    }
    // I4 (UB12.14) — the model-contract pointer. The red report names
    // live-manifest-contract.test.ts in its drift remedy anyway, so the needle is
    // the whole command plus the rewrite table, which only the pointer carries.
    if (!text.includes(MODEL_CONTRACT_TEST_COMMAND) || !text.includes('PI_TOOL_PRESENTATION_REWRITES')) {
      return `the ${label}-path report dropped the model-contract pointer — I4 (UB12.14); this gate compares no PI_STATIC_MODEL_CONTRACT_HASHES pin, a session-tool spelling can move one through PI_TOOL_PRESENTATION_REWRITES, and the line naming the test that would see it is the only place the Session-tools recipe learns so.`
    }
  }
  // I3 — all three digest-bearing fields are read. A narrowing back to
  // `schemaIdentity` alone lets a hand-edited, internally inconsistent pin past.
  const unreported = DIGEST_FIELDS.filter(field => !red.includes(field))
  if (unreported.length > 0) {
    return `the drift report does not name ${unreported.join(', ')} — I3; reading only one of the ${DIGEST_FIELDS.length} digest fields is how a hand-edited pin walks past this gate.`
  }
  return null
}

// ---------------------------------------------------------------------------
// P6.818 — the OTHER 75 pins, or as many of them as cost nothing
// ---------------------------------------------------------------------------

/**
 * P6.818 — the `live-json-schema` subset, recomputed on demand.
 *
 * THE GAP THIS CLOSES. The digest half above reads 6 of 81 pins. The remaining
 * 75 were recomputed only by `pi-harness-baseline.test.ts` under root `bun test`
 * — the command this whole file exists BECAUSE NOBODY RUNS — and the cost of
 * that gap is measured, not hypothetical: four pins sat wrong for days while the
 * green line read `6/6 match live source`, and a controller re-pin changed
 * nothing because `--pin` only ever touched the six.
 *
 * WHY THIS SUBSET AND NOT ALL 75. The blocker recorded above is real and stands:
 * the `live-tool-parameters` pins need the live Pi tool graph, whose imports were
 * measured at **336 145 ms**. The `live-json-schema` pins do not. Every one of
 * them is a `sessionTools` row whose payload is `getToolDefsAsJsonSchema(...)`'s
 * `inputSchema` from `packages/session-tools-core/src/tool-defs.ts`, which is a
 * plain schema module. Measured 2026-09-08 at load 7.5: **5.7 s cold**, of which
 * 5.73 s is that one dynamic import and 50 ms the 60 digests — 0.26 s user, so it
 * is page-cache I/O rather than work.
 *
 * WHY IT IS OPT-IN ANYWAY. 5.7 s on every `bun run typecheck` in this package is
 * a tax on every lane that edits an orchestrator file and has nothing to do with
 * the session tools; the import is DYNAMIC and reached only under the flag, so the
 * default path is byte-identical to what it was. Run it as
 * `bun run --cwd packages/pi-agent-server check:surface -- --live-json-schema`,
 * or `check:surface:live`, when you touch `session-tools-core` — and it is what
 * the four-pins-wrong episode needed somebody to be able to run.
 *
 * WHAT IT DOES NOT CLOSE, stated in this file's habit: the 14
 * `live-tool-parameters` pins are still read only by root `bun test`. That was
 * 66 of 81 when this mode landed, with `mcp.dynamic` the third population; P6.877
 * moved that one onto the DEFAULT path (it costs two `readFileSync` calls, not a
 * runtime graph), so the reachable total is 67 of 81 — 7 here plus 60 under this
 * flag — and the 14 that remain are the honest residue.
 */
export const LIVE_JSON_SCHEMA_KIND = 'live-json-schema'

/**
 * F1.114 (origin WI-bw) — the DESCRIPTION half of the same model-facing surface.
 *
 * WHAT WAS MEASURED, and why a fourth field rather than a wider payload. The
 * three digests above hash `inputSchema` and nothing else, so the gate is
 * exactly half-blind to what a model actually reads: on 2026-09-20 a
 * `.describe()` on ONE field of `AutomationCreateSchema` moved two rows, while
 * REWRITING both `automation_*` tool descriptions moved nothing at all and the
 * suite stayed 23 pass / 0 fail. A tool description is the first thing the model
 * is shown and the thing most often rewritten by hand, and it had no pin.
 *
 * It is its OWN field and deliberately NOT a member of {@link DIGEST_FIELDS},
 * because those three are held to be EQUAL to each other
 * ({@link findPinStructureFindings}'s "the three digest fields must agree") —
 * they are one hash in three spellings. This is a second, different hash, so
 * folding it in would make the agreement rule fire on every correct row.
 *
 * Widening the hashed payload to `{inputSchema, description}` was the other
 * candidate and is refused for a reason a reader will otherwise re-derive: it
 * would move all 61 pins at once and, worse, make every future report say only
 * "the pin moved" where today's says which half. A schema change and a wording
 * change have different remedies — one is a contract edit, the other is prose —
 * and a gate that cannot tell them apart teaches people to re-pin without
 * looking.
 *
 * SCOPE, and why it is the whole gap: this covers the 61 session tools, whose
 * descriptions had NO pin anywhere. The 20 Pi static and conditional rows had one
 * already — each carries a `modelContractHash` equal to its
 * `PI_STATIC_MODEL_CONTRACT_HASHES` entry, a hash over name, DESCRIPTION, schema
 * and prompt text, derived live by `live-manifest-contract.test.ts`.
 */
export const LIVE_TOOL_DESCRIPTION_KIND = 'live-tool-description'

/** The one field {@link LIVE_TOOL_DESCRIPTION_KIND} is stored in. */
export const DESCRIPTION_DIGEST_FIELD = 'descriptionDigest'

/** The half of a fixture row this comparison needs. */
export interface LiveSchemaRow {
  readonly semanticId: string
  readonly currentName: string
}

export interface LiveSchemaFinding {
  readonly semanticId: string
  readonly currentName: string
  readonly field: string
  readonly stored: string
  readonly expected: string
  readonly why: string
}

/**
 * The rule, PURE — the same discipline {@link findPinStructureFindings} is held
 * to, and for the same reason: a comparator whose branches were deleted looks
 * exactly like a clean tree, so {@link liveJsonSchemaSelfCheckFailure} drives
 * this over a planted digest change before the CLI trusts it on the real fixture.
 *
 * All three digest-bearing fields are compared as WHOLE strings, never as the hex
 * inside them — P2.235's finding, which applies here identically: the tool's own
 * name is hashed INTO the digest and also spelled in `bindingSchemaVersion`, so a
 * rename leaves a stale prefix beside a right hash.
 */
export function findLiveJsonSchemaFindings(
  rows: ReadonlyMap<string, LiveSchemaRow>,
  schemaContracts: Readonly<Record<string, Record<string, string>>>,
  liveDigest: (currentName: string) => string | undefined,
  // F1.114 — REQUIRED, not optional. An optional description source is one a
  // caller can forget, and a gate nobody passed an argument to is a gate that
  // reports nothing while printing a green line; that is the exact failure the
  // `live-json-schema` half was added to close.
  liveDescriptionDigest: (currentName: string) => string | undefined,
): LiveSchemaFinding[] {
  const findings: LiveSchemaFinding[] = []
  for (const [semanticId, contract] of Object.entries(schemaContracts)) {
    if ((contract.evidenceKind ?? '') !== LIVE_JSON_SCHEMA_KIND) continue
    const row = rows.get(semanticId)
    if (!row) {
      findings.push({
        semanticId, currentName: '', field: '(row)', stored: '(absent)',
        expected: 'a sessionTools row',
        why: 'a live-json-schema pin with no row names no tool, so nothing can look its schema up.',
      })
      continue
    }
    const live = liveDigest(row.currentName)
    if (live === undefined) {
      findings.push({
        semanticId, currentName: row.currentName, field: '(live definition)', stored: '(absent)',
        expected: `a tool named ${row.currentName} in getToolDefsAsJsonSchema`,
        why: 'the pinned tool is not in the live surface at all — a removal, which reads as coverage until somebody looks.',
      })
      continue
    }
    const expected: Record<string, string> = {
      schemaIdentity: `${LIVE_JSON_SCHEMA_KIND}:sha256:${live}`,
      modelSchemaVersion: `${LIVE_JSON_SCHEMA_KIND}/sha256:${live}`,
      bindingSchemaVersion: `exact-name:${row.currentName}/sha256:${live}`,
    }
    for (const [field, want] of Object.entries(expected)) {
      const stored = contract[field] ?? ''
      if (stored === want) continue
      findings.push({
        semanticId, currentName: row.currentName, field, stored: stored || '(absent)', expected: want,
        why: 'the live inputSchema of this tool no longer hashes to what the fixture pins — this IS a model-facing change, unlike the six source-state digests above.',
      })
    }
    // F1.114 — the description half. Reported separately from the three above so
    // the report says WHICH half moved: a schema change is a contract edit and a
    // wording change is prose, and they have different remedies.
    const liveDescription = liveDescriptionDigest(row.currentName)
    const wantDescription = liveDescription === undefined
      ? undefined
      : `${LIVE_TOOL_DESCRIPTION_KIND}:sha256:${liveDescription}`
    const storedDescription = contract[DESCRIPTION_DIGEST_FIELD] ?? ''
    if (wantDescription !== undefined && storedDescription !== wantDescription) {
      findings.push({
        semanticId, currentName: row.currentName, field: DESCRIPTION_DIGEST_FIELD,
        stored: storedDescription || '(absent)', expected: wantDescription,
        why: storedDescription.length === 0
          ? 'this live-json-schema pin carries no description digest, so the sentence the model reads first is pinned by nothing — F1.114.'
          : 'the live DESCRIPTION of this tool no longer hashes to what the fixture pins. The inputSchema may be untouched; a description is model-facing on its own.',
      })
    }
  }
  return findings
}

/**
 * P6.818 — the comparator proving it can go RED, on the command that runs it.
 *
 * Three synthetic pins: one clean (must produce nothing), one whose digest moved
 * (the whole point — and it must be reported on all three fields, because reading
 * one is how a hand-edited pin walks past a gate), and one naming a tool the live
 * surface no longer has.
 */
export function liveJsonSchemaSelfCheckFailure(): string | null {
  const live = 'c'.repeat(64)
  const stale = 'd'.repeat(64)
  const commit = 'e'.repeat(40)
  const describedLive = 'f'.repeat(64)
  const pin = (name: string, digest: string, description = describedLive): Record<string, string> => ({
    evidenceKind: LIVE_JSON_SCHEMA_KIND,
    schemaIdentity: `${LIVE_JSON_SCHEMA_KIND}:sha256:${digest}`,
    modelSchemaVersion: `${LIVE_JSON_SCHEMA_KIND}/sha256:${digest}`,
    bindingSchemaVersion: `exact-name:${name}/sha256:${digest}`,
    [DESCRIPTION_DIGEST_FIELD]: `${LIVE_TOOL_DESCRIPTION_KIND}:sha256:${description}`,
    handlerSchemaVersion: `packages/present.ts#handlerOk@${commit}`,
  })
  const rows = new Map<string, LiveSchemaRow>([
    ['ok', { semanticId: 'ok', currentName: 'tool_ok' }],
    ['moved', { semanticId: 'moved', currentName: 'tool_moved' }],
    ['gone', { semanticId: 'gone', currentName: 'tool_gone' }],
    // F1.114's own mutant: the SCHEMA is right and only the description moved,
    // which is the state the gate was blind to before this field existed.
    ['reworded', { semanticId: 'reworded', currentName: 'tool_reworded' }],
  ])
  const findings = findLiveJsonSchemaFindings(
    rows,
    {
      ok: pin('tool_ok', live),
      moved: pin('tool_moved', stale),
      gone: pin('tool_gone', live),
      reworded: pin('tool_reworded', live, stale),
    },
    currentName => (currentName === 'tool_gone' ? undefined : live),
    currentName => (currentName === 'tool_gone' ? undefined : describedLive),
  )
  if (findings.some(finding => finding.semanticId === 'ok')) {
    return 'the live-json-schema comparator reports a finding against a pin that matches its live digest — '
      + 'it would fire on every correct fixture, which is how a gate gets switched off.'
  }
  const movedFields = new Set(findings.filter(f => f.semanticId === 'moved').map(f => f.field))
  const unreported = DIGEST_FIELDS.filter(field => !movedFields.has(field))
  if (unreported.length > 0) {
    return `the live-json-schema comparator does not report ${unreported.join(', ')} for a pin whose digest moved — `
      + 'a planted change has to be caught in every digest-bearing field, because reading one is how an '
      + 'internally inconsistent pin passes.'
  }
  if (!findings.some(finding => finding.semanticId === 'gone')) {
    return 'the live-json-schema comparator ignores a pin whose tool is absent from the live surface, so a '
      + 'removed tool would keep its pin and read as covered.'
  }
  // F1.114 — and it must be reported on the DESCRIPTION field alone: a reworded
  // tool whose schema is untouched is precisely what moved nothing before this
  // field, and a report that named `schemaIdentity` would send the reader to
  // re-pin a payload that never changed.
  const reworded = findings.filter(finding => finding.semanticId === 'reworded').map(finding => finding.field)
  if (reworded.length !== 1 || reworded[0] !== DESCRIPTION_DIGEST_FIELD) {
    return 'the live-json-schema comparator does not report a tool whose DESCRIPTION moved while its schema '
      + `did not, on ${DESCRIPTION_DIGEST_FIELD} and on that field alone — the half F1.114 exists to close.`
  }
  return null
}

/**
 * Every live `mcp__session__*` tool's `inputSchema` digest, keyed by tool name.
 *
 * The enumeration is `pi-harness-baseline.test.ts`'s, deliberately — both
 * `NESSY_ENABLE_TASKS` states and both option sets, unioned — because a single
 * enumeration cannot see every tool: the task checklist and the legacy
 * TodoWrite/Task pair are mutually exclusive, and `ReviewDiff` appears in neither
 * Pi state. Two derivations of one number is what makes a gate and its test
 * disagree, so this one is copied on purpose and says so.
 *
 * `delete` before every assignment and on the restore path: assigning to
 * `process.env.X` in Bun 1.3.14 can leave the name readable by property and
 * invisible to a spread, which is the documented trap in `AGENTS.md`.
 */
async function liveJsonSchemaDigests(): Promise<Map<string, { schema: string, description: string }>> {
  // DYNAMIC, and reached only under `--live-json-schema`: a static import would
  // put this module graph on every `bun run typecheck` in the package.
  const { getToolDefsAsJsonSchema } = await import('../../../session-tools-core/src/tool-defs.ts')
  const digests = new Map<string, { schema: string, description: string }>()
  for (const value of ['1', '0']) {
    const previous = process.env.NESSY_ENABLE_TASKS
    delete process.env.NESSY_ENABLE_TASKS
    process.env.NESSY_ENABLE_TASKS = value
    try {
      for (const options of [
        { prefix: 'mcp__session__', includeDeveloperFeedback: true, projection: 'pi' as const },
        // P6.148 — `web_search` is gated by `hostWebSearch` the way `ReviewDiff`
        // is gated by `reviewDiffPort`: a per-session offer, so the enumeration
        // has to ask for it or the pin reads as a REMOVAL.
        { prefix: 'mcp__session__', includeDeveloperFeedback: true, reviewDiffPort: true, hostWebSearch: true },
        // UB6.11 — `decide` is port-gated like `ReviewDiff`; the enumeration asks for it
        // or the pin reads as a REMOVAL.
        { prefix: 'mcp__session__', includeDeveloperFeedback: true, decidePort: true },
      ]) {
        for (const definition of getToolDefsAsJsonSchema(options)) {
          digests.set(definition.name, {
            schema: createHash('sha256').update(canonicalJson(definition.inputSchema)).digest('hex'),
            // F1.114 — the RAW description string, not a canonical-JSON wrapper:
            // it is already a string, and hashing `JSON.stringify` of it would
            // add a quoting layer nobody reading the field could reproduce by
            // hand. An absent description hashes the empty string, so a tool
            // that LOSES its description moves the pin rather than silently
            // matching a pin taken while it had one.
            description: createHash('sha256').update(definition.description ?? '').digest('hex'),
          })
        }
      }
    } finally {
      delete process.env.NESSY_ENABLE_TASKS
      if (previous !== undefined) process.env.NESSY_ENABLE_TASKS = previous
    }
  }
  return digests
}

/** The red report for the live subset, shaped like the two above it. */
export function renderLiveJsonSchemaReport(findings: readonly LiveSchemaFinding[]): string[] {
  const lines: string[] = ['']
  lines.push('LIVE JSON-SCHEMA DRIFT — a pinned tool no longer matches the live tool definition.')
  lines.push('Unlike the six source-state digests, this IS a model-facing change: the payload is the')
  lines.push('`inputSchema` the model is shown, or — on the `descriptionDigest` field, F1.114 — the')
  lines.push('`description` it reads first. Which field is named tells you which half moved.')
  lines.push('')
  for (const finding of findings) {
    lines.push(`  ${finding.semanticId} (${finding.currentName || 'no row'}) · ${finding.field}`)
    lines.push(`    stored:   ${finding.stored}`)
    lines.push(`    expected: ${finding.expected}`)
    lines.push(`    why:      ${finding.why}`)
  }
  lines.push('')
  lines.push(`  Re-pin by hand in ${SOURCE_STATE_FIXTURE} (root \`bun test\` never writes it; its baseline`)
  lines.push('  toEqual diff prints the whole object) — `--pin` covers the six source-state digests ONLY.')
  lines.push('')
  return lines
}

async function runLiveJsonSchema(repoRoot: string): Promise<number> {
  const selfCheck = liveJsonSchemaSelfCheckFailure()
  if (selfCheck !== null) {
    throw new SourceStateGateRefusal(
      `${selfCheck}\n\n`
      + '  This is the gate checking its own comparator against a PLANTED change before running it\n'
      + '  on the real fixture (P6.818, the P2.255 discipline). The same invariants are asserted in\n'
      + '  src/harness/source-state-contract.test.ts, under root `bun test`.',
    )
  }
  const fixture = JSON.parse(readFileSync(resolve(repoRoot, SOURCE_STATE_FIXTURE), 'utf8')) as {
    schemaContracts?: Record<string, Record<string, string>>
  }
  const schemaContracts = fixture.schemaContracts ?? {}
  const rows = new Map<string, LiveSchemaRow>(
    [...readPinRows(repoRoot)].map(([semanticId, row]) => [semanticId, { semanticId, currentName: row.currentName }]),
  )
  const digests = await liveJsonSchemaDigests()
  const findings = findLiveJsonSchemaFindings(
    rows,
    schemaContracts,
    name => digests.get(name)?.schema,
    name => digests.get(name)?.description,
  )
  const census = censusSchemaContracts(repoRoot)
  const covered = Object.values(schemaContracts).filter(c => (c.evidenceKind ?? '') === LIVE_JSON_SCHEMA_KIND).length
  if (findings.length > 0) {
    for (const line of renderLiveJsonSchemaReport(findings)) console.error(line)
    return 1
  }
  console.log(`live-json-schema pins: ${covered}/${covered} match the live tool definitions, all `
    + `${DIGEST_FIELDS.length} digest fields each plus the ${DESCRIPTION_DIGEST_FIELD} F1.114 added (${digests.size} live tools enumerated).`)
  console.log(`  Coverage: ${covered} of ${census.total} schemaContracts, and this mode reads ONLY the`)
  console.log(`  live-json-schema kind. The ${census.total - covered - SOURCE_STATE_COVERED_SEMANTIC_IDS.length} pins that are`)
  console.log(`  neither this kind nor the ${SOURCE_STATE_COVERED_SEMANTIC_IDS.length} source-text digests need the live Pi tool graph (336 s of`)
  console.log('  imports, measured) and are still recomputed only by pi-harness-baseline.test.ts under')
  console.log('  root `bun test`.')
  return 0
}

// ---------------------------------------------------------------------------
// P6.1077 — the `--pin` guard: a re-pin that leaves the MODEL contract behind
// ---------------------------------------------------------------------------

/**
 * P6.1077 — what `--pin` used to say nothing about, and the day it cost.
 *
 * THE DEFECT, measured. `d0e61e7ff` (P6.798, 2026-09-10) rewrote the `review`
 * tool's `background` parameter DESCRIPTION — model-visible by definition — and
 * re-pinned only the source-state digest in `fixtures/tool-surface.json` with
 * `check:surface -- --pin`. `PI_STATIC_MODEL_CONTRACT_HASHES.review`
 * (`packages/shared/src/agent/pi-harness/harness-tool-descriptor.ts`) stayed at
 * `a1ff1b57…`. `harness-manifest.ts` builds the PRODUCTION manifest from
 * `getPiStaticModelContractHash`, so from that commit every live Pi session
 * carrying `review` died on its FIRST turn with `Pi execution manifest model
 * contract mismatch for review`, for a day, until W11-pi moved the constant to
 * `2b8a0396…` in `75811952f`.
 *
 * The split is exactly the one {@link renderDriftReport} already prints in
 * WORDS — *"model-facing declaration moved -> PI_STATIC_MODEL_CONTRACT_HASHES
 * must move too"*. Words were not enough: `--pin` re-pinned, exited 0, and said
 * nothing, and `live-manifest-contract.test.ts` — the guard written for this
 * failure — sat red at HEAD for a day because it rides root `bun test`, which no
 * lane runs in an implementation loop.
 *
 * WHAT THIS ADDS. `--pin` now recomputes the model-facing hash the way the
 * PRODUCTION path takes it and refuses when it has parted from the pinned table.
 * It is the same comparison `live-manifest-contract.test.ts` makes; the point is
 * WHERE it runs — on the command that would otherwise silence the evidence.
 *
 * WHAT IT COSTS, and why only `--pin` pays it. The live hash cannot be derived
 * from source text: it is taken over the CONSTRUCTED tool definition, so the
 * live Pi tool graph has to be imported. Measured 2026-09-11 on this rig, cold:
 * `live-manifest-compositions.ts` imports in **327 407 ms** at load 11.9 with
 * `user 2.00 sys 1.00` — 0.9 % cpu, i.e. per-file-open I/O and not computation —
 * while `buildLiveCompositions` itself then runs in milliseconds; the whole of
 * {@link collectModelContractPartings} against the real table then measured
 * **228 868 ms** (`user 1.53 sys 0.66`, load 11.4) on a warmer cache, returning
 * zero partings. Both are readings with a date, and the spread between them is
 * the page cache, not the work. That is why
 * the import is DYNAMIC and sits inside the `--pin` branch, after drift is known
 * non-empty: `bun run typecheck` in this package, the command every lane runs,
 * pays nothing and stays byte-identical. It is the same shape
 * `--live-json-schema` uses one screen up, for the same reason.
 *
 * WHAT IT DOES NOT CLOSE. A green `--pin` is not a statement that the pinned
 * table is RIGHT for tools this gate does not cover: it compares only the
 * {@link SOURCE_STATE_FACTORIES} six, because those are the pins `--pin`
 * rewrites. The whole table, and both BUILT bundles, are still compared only by
 * `src/harness/live-manifest-contract.test.ts` under root `bun test`.
 */
export interface ModelContractProjection {
  /** The live composition it was taken in — `live+session`, `fork-mode+session`, … */
  readonly composition: string
  /** The manifest binding, i.e. a key of {@link SOURCE_STATE_FACTORIES}. */
  readonly bindingName: string
  /** The key in `PI_STATIC_MODEL_CONTRACT_HASHES`; `subagent` has two. */
  readonly pinKey: string
  /** The hash the live projection produces — what a session would enforce. */
  readonly live: string
}

/** One projection whose live hash no longer matches the pinned table. */
export interface ModelContractParting extends ModelContractProjection {
  /** `PI_STATIC_MODEL_CONTRACT_HASHES[pinKey]` — what the manifest declares. */
  readonly pinned: string
}

/**
 * The comparison, as a PURE function over plain values, so the rule can be
 * asserted without importing five minutes of module graph — the same split
 * {@link findLiveJsonSchemaFindings} uses.
 *
 * A projection whose `pinKey` is absent from the table is SKIPPED rather than
 * reported: an unpinned tool is a different finding (`live-manifest-contract`'s
 * own loops skip it too), and manufacturing one here would make this guard fire
 * on every composition that carries a tool nobody pinned.
 */
export function findModelContractPartings(
  projections: Iterable<ModelContractProjection>,
  pins: Readonly<Record<string, string>>,
): ModelContractParting[] {
  const partings: ModelContractParting[] = []
  const seen = new Set<string>()
  for (const projection of projections) {
    const pinned = pins[projection.pinKey]
    if (pinned === undefined) continue
    if (pinned === projection.live) continue
    // One parting per composition and pin: the four compositions carry the same
    // tool and would otherwise report one defect four times.
    const key = `${projection.composition} ${projection.pinKey}`
    if (seen.has(key)) continue
    seen.add(key)
    partings.push({ ...projection, pinned })
  }
  return partings
}

/**
 * The refusal report — PURE, so {@link modelContractSelfCheckFailure} can assert
 * its shape before it is printed, the way I1/I2/I3 are asserted for the drift
 * report.
 *
 * It names the TOOL and BOTH hashes, because the remedy is to type one of them
 * into a constant by hand and a report that printed only "they differ" would
 * send the reader off to recompute what the gate already holds.
 */
export function renderModelContractPartingReport(partings: readonly ModelContractParting[]): string[] {
  const lines: string[] = ['']
  lines.push('--pin REFUSED — the MODEL-FACING contract of a tool you are re-pinning has moved and')
  lines.push('PI_STATIC_MODEL_CONTRACT_HASHES has not moved with it.')
  lines.push('')
  lines.push('  Re-pinning now would silence the source-state digest and leave the split standing.')
  lines.push('  That split is FIRST-TURN FATAL: the host builds the production manifest from the')
  lines.push('  pinned table, so every live Pi session carrying the tool dies with')
  lines.push('  `Pi execution manifest model contract mismatch for <tool>` (measured: d0e61e7ff')
  lines.push('  shipped exactly this for `review`, and it stood for a day).')
  lines.push('')
  for (const parting of partings) {
    lines.push(`  ${parting.bindingName} in composition ${parting.composition}, pin key ${parting.pinKey}`)
    lines.push(`    pinned: ${parting.pinned}`)
    lines.push(`    live:   ${parting.live}`)
  }
  lines.push('')
  lines.push('  THE REMEDY, the way 75811952f took it:')
  lines.push('    1. decide which edit you made. Model-facing (name, description, promptSnippet,')
  lines.push('       promptGuidelines, parameters — a parameter DESCRIPTION counts) means the table')
  lines.push('       moves; implementation-only means this refusal is a bug, because the live hash')
  lines.push('       should not have moved at all.')
  lines.push('    2. set the pin to the `live:` value above, by hand, in')
  lines.push('       packages/shared/src/agent/pi-harness/harness-tool-descriptor.ts, with a dated')
  lines.push('       comment saying what moved;')
  lines.push('    3. move the fixture row that mirrors it in')
  lines.push(`       ${SOURCE_STATE_FIXTURE};`)
  lines.push('    4. rebuild and restage the subprocess — `bun run electron:build:servers` — because a')
  lines.push('       BUILT bundle embeds the table and a stale one is the same live failure;')
  lines.push('    5. run `bun test src/harness/live-manifest-contract.test.ts` from this package: it is')
  lines.push('       the guard that compares the WHOLE table and both built bundles;')
  lines.push('    6. then re-run `check:surface -- --pin`.')
  lines.push('')
  return lines
}

/**
 * P6.1077 — the comparator proving it can go RED before it is trusted on the
 * real table (the P2.255 / P6.818 discipline, and the reason this file's other
 * two comparators each carry one).
 *
 * Three synthetic projections: one that agrees (must produce nothing), one whose
 * live hash moved (the whole point), and one the table does not pin at all (must
 * be ignored rather than reported). Then the report itself, because a refusal
 * that named the tool and not the hashes would send the reader back to recompute
 * what it already had.
 */
export function modelContractSelfCheckFailure(): string | null {
  const pinned = 'a'.repeat(64)
  const moved = 'b'.repeat(64)
  const pins = { agrees: pinned, parts: pinned }
  const projection = (bindingName: string, live: string): ModelContractProjection =>
    ({ composition: 'live+session', bindingName, pinKey: bindingName, live })
  const partings = findModelContractPartings(
    [projection('agrees', pinned), projection('parts', moved), projection('unpinned', moved)],
    pins,
  )
  if (partings.some(parting => parting.bindingName === 'agrees')) {
    return 'the model-contract comparator reports a parting against a tool whose live hash equals its pin — '
      + 'it would refuse every correct `--pin`, which is how a gate gets switched off.'
  }
  if (partings.some(parting => parting.bindingName === 'unpinned')) {
    return 'the model-contract comparator reports a tool PI_STATIC_MODEL_CONTRACT_HASHES does not pin — '
      + 'an unpinned tool is a different finding, and reporting it here would fire on every composition.'
  }
  const parted = partings.find(parting => parting.bindingName === 'parts')
  if (parted === undefined) {
    return 'the model-contract comparator ignores a tool whose live hash has moved away from its pin — '
      + 'that is the first-turn-fatal split this guard exists for, and `--pin` would silence it.'
  }
  const report = renderModelContractPartingReport([parted]).join('\n')
  for (const [what, needle] of [['the tool', 'parts'], ['the pinned hash', pinned], ['the live hash', moved]] as const) {
    if (!report.includes(needle)) {
      return `the model-contract refusal does not name ${what}, so the reader cannot act on it without `
        + 'recomputing what the gate already holds.'
    }
  }
  if (!report.includes('harness-tool-descriptor.ts')) {
    return 'the model-contract refusal does not name the file the pin is typed into, so it states a '
      + 'failure and withholds its remedy.'
  }
  return null
}

/**
 * Every source-state tool's live model-facing hash, taken the way the PRODUCTION
 * path takes it, against the pinned table.
 *
 * Deliberately built on `live-manifest-compositions.ts` rather than on a second
 * construction of the same surface: that module exists BECAUSE two files kept
 * their own copies of it, and a third copy here would be the same defect again.
 * It is also what makes all four compositions reachable without restating any of
 * them — fork mode included, whose `subagent` carries a pin of its own.
 */
export async function collectModelContractPartings(repoRoot: string): Promise<ModelContractParting[]> {
  // DYNAMIC, and reached only under `--pin`: see this section's header for the
  // measurement that decides it (327 s, 0.9 % cpu, cold).
  const { buildLiveCompositions } = await import('./live-manifest-compositions.ts')
  const { hashProjectedPiToolDefinition } = await import('./tool-manifest.ts')
  const { piStaticModelContractPinKey } = await import('../../../shared/src/agent/pi-harness/harness-manifest.ts')
  const { PI_STATIC_MODEL_CONTRACT_HASHES } = await import(
    '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts'
  )
  // D1.119 — EVERY pinned tool, not only the six this gate re-pins.
  //
  // The projection loop used to skip any binding outside `covered` — the six
  // factory names — so a parting on bash, read, mcp__tool_search or any of the
  // other fifteen pinned tools was invisible to every command a lane runs, and
  // `--pin` would silence the six while one of them stood. (The removed line is
  // described rather than quoted: a comment spelling the old code re-creates
  // the finding for every guard that greps for it — AGENTS.md §Traps, and this
  // paragraph's first draft did exactly that and turned the case below red.)
  // The split is equally fatal whichever tool carries it: the host builds the
  // production manifest from the pinned table, so the session dies on its FIRST
  // turn either way.
  //
  // It costs nothing to widen: the expense here is the module graph imported
  // above (327 s cold, 0.9 % cpu — per-file-open I/O), and comparing more
  // projections out of compositions already built is microseconds.
  // `findModelContractPartings` skips a pinKey the table does not carry, so an
  // UNPINNED tool is still not a finding — the same rule
  // `live-manifest-contract.test.ts` applies with its own `if (!pin) continue`.
  const covered = new Set(Object.keys(SOURCE_STATE_FACTORIES))
  const projections: ModelContractProjection[] = []
  const reached = new Set<string>()
  for (const { label, manifest, definitions } of buildLiveCompositions(repoRoot)) {
    for (const tool of manifest.tools) {
      const bindingName = tool.binding.bindingName
      const definition = definitions.find(candidate => candidate.name === bindingName)
      if (definition === undefined) continue
      // `reached` still answers for the SIX alone (`unreached` reads `covered`),
      // so the refusal below keeps its exact meaning: a factory whose pin would
      // be compared against nothing. Names outside the six land in this set too
      // and are never read.
      reached.add(bindingName)
      projections.push({
        composition: label,
        bindingName,
        pinKey: piStaticModelContractPinKey(bindingName, manifest.orchestrator),
        live: hashProjectedPiToolDefinition(manifest, tool, definition),
      })
    }
  }
  // Guard the guard, the way live-manifest-contract.test.ts does: a tool no
  // composition carries is a pin compared against NOTHING, and a check that
  // silently compared nothing would read as a pass.
  const unreached = [...covered].filter(name => !reached.has(name))
  if (unreached.length > 0) {
    throw new SourceStateGateRefusal(
      `the live compositions carry no definition for ${unreached.join(', ')}, so the model-contract `
      + 'check would compare those pins against nothing and report a pass. Either the composition in '
      + 'live-manifest-compositions.ts stopped building the tool, or the factory no longer returns a '
      + 'definition named for its binding — decide which before re-pinning.',
    )
  }
  return findModelContractPartings(projections, PI_STATIC_MODEL_CONTRACT_HASHES)
}

/**
 * The `--pin` decision, in one place so it can be driven in a test without the
 * five-minute import: `collect` is injectable and defaults to the real one.
 *
 * Returns the refusal report, or `null` to let the rewrite proceed.
 */
export async function pinModelContractRefusal(
  repoRoot: string,
  collect: (root: string) => Promise<readonly ModelContractParting[]> = collectModelContractPartings,
): Promise<string[] | null> {
  const selfCheck = modelContractSelfCheckFailure()
  if (selfCheck !== null) {
    throw new SourceStateGateRefusal(
      `${selfCheck}\n\n`
      + '  This is the gate checking its own model-contract comparator against a PLANTED parting\n'
      + '  before running it on the real table (P6.1077). The same invariants are asserted in\n'
      + '  scripts/check-surface-selftest.ts and in src/harness/source-state-contract.test.ts.',
    )
  }
  const partings = await collect(repoRoot)
  return partings.length === 0 ? null : renderModelContractPartingReport(partings)
}

/**
 * D1.119 — the BUILT bundles, the other half the row names.
 *
 * A bundle is a snapshot of the ENFORCEMENT side: it embeds the pin table, and
 * a stale one fails a live session with `Pi execution manifest model contract
 * mismatch` while every source-reading gate is green. `electron:dev` runs Pi
 * from these bundles (AGENTS.md), so this is the state a lane meets as an app
 * that will not answer, diagnosed from source.
 *
 * It was checked ONLY by `live-manifest-contract.test.ts` under root `bun test`,
 * a command no lane runs in an implementation loop. Here it costs two
 * `readFileSync`es and no module graph at all — it does not ride the `--pin`
 * import and is not gated behind it.
 *
 * REPORTED, NEVER REFUSED, and the reason is structural rather than cautious:
 * the bundle embeds the table, so a legitimate re-pin MAKES the bundle stale.
 * A refusal before the rewrite could never be satisfied (the rebuild has to
 * come after), and one after it would be reporting a state this command had
 * just created. So the green path notes it and `--pin` says it as the next
 * step. A bundle that is absent is not a finding: not every checkout has built
 * one.
 */
export const BUILT_PI_BUNDLE_PATHS: readonly string[] = Object.freeze([
  'packages/pi-agent-server/dist/index.js',
  'apps/electron/resources/pi-agent-server/index.js',
])

export interface StaleBundle {
  /** Repo-relative, as the operator would type it. */
  readonly path: string
  /** The binding names whose current pin the bundle does not carry. */
  readonly missing: readonly string[]
}

export function findStaleBundles(
  repoRoot: string,
  pins: Readonly<Record<string, string>>,
  readBundle: (path: string) => string | null = path => (existsSync(path) ? readFileSync(path, 'utf8') : null),
): StaleBundle[] {
  const stale: StaleBundle[] = []
  for (const relative of BUILT_PI_BUNDLE_PATHS) {
    const contents = readBundle(resolve(repoRoot, relative))
    if (contents === null) continue
    const missing = Object.entries(pins)
      .filter(([, hash]) => !contents.includes(hash))
      .map(([bindingName]) => bindingName)
    if (missing.length > 0) stale.push({ path: relative, missing })
  }
  return stale
}

/** PURE, so the wording is asserted without building a bundle. */
export function renderStaleBundleNote(stale: readonly StaleBundle[]): string[] {
  if (stale.length === 0) return []
  const lines = ['']
  lines.push('  BUILT BUNDLE STALE — the pins are right in source and wrong in what would RUN.')
  for (const bundle of stale) {
    lines.push(`    ${bundle.path} does not embed the current pin for ${bundle.missing.join(', ')}`)
  }
  lines.push('    A live Pi session on this bundle dies with `Pi execution manifest model contract')
  lines.push('    mismatch`, and `electron:dev` runs Pi from exactly these files. Rebuild:')
  lines.push('      bun run electron:build:servers')
  return lines
}

/** The current table, imported where it is needed so the default path is unchanged. */
async function currentModelContractPins(): Promise<Readonly<Record<string, string>>> {
  const { PI_STATIC_MODEL_CONTRACT_HASHES } = await import(
    '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts'
  )
  return PI_STATIC_MODEL_CONTRACT_HASHES
}

async function run(argv: readonly string[], repoRoot = resolve(import.meta.dir, '..', '..', '..', '..')): Promise<number> {
  // P6.818 — its own gate, with its own self-check, so the default path stays
  // byte-identical and pays nothing for a mode it does not run.
  if (argv.includes('--live-json-schema')) return runLiveJsonSchema(repoRoot)
  const pin = argv.includes('--pin')
  // P6.877 — seven, not six: the six factories plus the dynamic-wire pin, read
  // from the one derived list so no count here can disagree with the coverage
  // sentence beside it.
  const total = SOURCE_STATE_COVERED_SEMANTIC_IDS.length
  const shapeFailure = reportShapeSelfCheckFailure(repoRoot, total)
    ?? structureSelfCheckFailure()
    ?? dynamicWireSourceSelfCheckFailure()
  if (shapeFailure !== null) {
    throw new SourceStateGateRefusal(
      `${shapeFailure}\n\n`
      + '  This is the gate checking its OWN output before printing it (P2.255). The invariant\n'
      + '  it names is asserted properly in src/harness/source-state-contract.test.ts, which runs\n'
      + '  under root `bun test` — a command no lane runs in its implementation loop, which is why\n'
      + '  the check is repeated here.',
    )
  }
  // P2.235 — the structural half runs FIRST and on every path, `--pin` included:
  // `--pin` rewrites digest-bearing fields and cannot repair a stale name or a
  // moved handler, so silencing drift while a structure finding stands would put
  // the fixture back into exactly the state this gate reported green.
  const structure = collectPinStructureFindings(repoRoot)
  if (structure.length > 0) {
    for (const line of renderPinStructureReport(structure)) console.error(line)
    return 1
  }
  // P6.877 — one list, so the report, the hand-edit split and `--pin` all reach
  // the seventh pin without a second copy of any of them.
  const drift = [...collectSourceStateDrift(repoRoot), ...collectDynamicWireSourceDrift(repoRoot)]
  if (drift.length === 0) {
    for (const line of renderGreenReport(repoRoot, total)) console.log(line)
    // D1.119 — source is green; say whether what would RUN is. Two file reads,
    // no module graph (the pin table itself imports in 0.08 s, measured), and a
    // note rather than a failure: see {@link findStaleBundles}.
    for (const line of renderStaleBundleNote(findStaleBundles(repoRoot, await currentModelContractPins()))) {
      console.log(line)
    }
    return 0
  }
  if (pin) {
    // P6.1077 — BEFORE the rewrite, for the reason the structural half runs
    // first: silencing the source-state digest while the MODEL contract has
    // parted from it is the shipped defect this guard exists for, and a refusal
    // raised after the write would be reporting a state it had just created.
    console.log('--pin: checking the model-facing contract of every source-state tool against')
    console.log('  PI_STATIC_MODEL_CONTRACT_HASHES before re-pinning anything. This imports the live')
    console.log('  Pi tool graph and takes MINUTES on a cold page cache (327 s measured 2026-09-11 at')
    console.log('  0.9 % cpu — it is per-file-open I/O, not computation). Nothing else pays it.')
    const refusal = await pinModelContractRefusal(repoRoot)
    if (refusal !== null) {
      for (const line of refusal) console.error(line)
      return 1
    }
    for (const row of drift) {
      rewritePin(repoRoot, row)
      console.log(`re-pinned ${row.semanticId}: ${row.stored.schemaIdentity} -> ${row.live}`)
    }
    // D1.119 — AFTER the rewrite, because a legitimate re-pin is what makes a
    // built bundle stale. This is the next step, not a refusal.
    for (const line of renderStaleBundleNote(findStaleBundles(repoRoot, await currentModelContractPins()))) {
      console.log(line)
    }
    return 0
  }
  for (const line of renderDriftReport(repoRoot, drift, total)) console.error(line)
  return 1
}

/**
 * A refusal (a deleted field, a renamed factory, an inconsistent pin) is the
 * output an operator hits MID-MISTAKE, so it gets the same formatted block as
 * drift rather than a raw stack trace.
 */
async function main(argv: readonly string[]): Promise<number> {
  try {
    return await run(argv)
  } catch (error) {
    console.error('')
    console.error('SOURCE-STATE CONTRACT CHECK REFUSED — the gate could not decide, so it did not pass.')
    console.error('')
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    // A DELIBERATE refusal is fully described by its message. Anything else is a
    // bug in this gate, and swallowing its stack would let a crash read to an
    // operator as a fixture problem — the wrong file to go and edit.
    if (!(error instanceof SourceStateGateRefusal)) {
      console.error('')
      console.error('  This is NOT one of this gate\'s own refusals — it is a fault in the gate itself:')
      console.error(error instanceof Error && error.stack ? error.stack : String(error))
    }
    console.error('')
    return 1
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
