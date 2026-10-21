/**
 * P2.116 — the gate's own signal, pinned by something that SHIPS.
 *
 * The three invariants this file exists for were, until it existed, held up
 * only by a scratchpad mutation campaign that CI never runs and no lane keeps:
 *   I1  the drift headline must not claim the pin is model-facing;
 *   I2  the coverage caveat must print on the RED path, not only the green one;
 *   I3  all three digest-bearing fields are read, not just `schemaIdentity`.
 * An edit re-narrowing the gate to one field, or dropping `coverageLine()` from
 * the red branch, would have gone green in silence — I1/I2/I3 recurring with
 * nothing to catch them. That is the row's own defect, one level up.
 *
 * Every case below runs against a SYNTHETIC `repoRoot` in a temp directory:
 * both the fixture path and every factory path already resolve through
 * `resolve(repoRoot, …)`, so nothing here touches the real tree, mutates a
 * shared file, or needs `scripts/bun-test-lock.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'

import {
  DIGEST_FIELDS,
  LIVE_JSON_SCHEMA_KIND,
  MODEL_CONTRACT_TEST_COMMAND,
  DYNAMIC_WIRE_SOURCE_PIN,
  SOURCE_STATE_COVERED_SEMANTIC_IDS,
  SOURCE_STATE_FACTORIES,
  SOURCE_STATE_FIXTURE,
  SOURCE_TEXT_EVIDENCE_KINDS,
  PIN_FIELDS,
  SourceStateGateRefusal,
  canonicalJson,
  censusSchemaContracts,
  collectDynamicWireSourceDrift,
  collectPinStructureFindings,
  collectSourceStateDrift,
  coverageLine,
  describeReportShapeFailure,
  dynamicWireSourcePayload,
  dynamicWireSourcePayloadDigest,
  dynamicWireSourceSelfCheckFailure,
  pinIsInternallyInconsistent,
  renderDriftReport,
  renderGreenReport,
  reportShapeSelfCheckFailure,
  structureSelfCheckFailure,
  BUILT_PI_BUNDLE_PATHS,
  DESCRIPTION_DIGEST_FIELD,
  findLiveJsonSchemaFindings,
  LIVE_TOOL_DESCRIPTION_KIND,
  findModelContractPartings,
  findStaleBundles,
  renderStaleBundleNote,
  liveJsonSchemaSelfCheckFailure,
  modelContractPointerLines,
  modelContractSelfCheckFailure,
  pinModelContractRefusal,
  rewritePin,
  unreadSemanticIds,
} from './source-state-contract.ts'

const REVIEW = SOURCE_STATE_FACTORIES.review!
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function write(root: string, relative: string, contents: string): void {
  const path = resolve(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

function digestOf(sourcePath: string, factorySource: string): string {
  return createHash('sha256').update(canonicalJson({ sourcePath, factorySource })).digest('hex')
}

/** A whole synthetic repo: one file per factory, and a fixture pinned to them. */
function makeRoot(options: { extraContracts?: Record<string, { evidenceKind: string }> } = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'p2116-'))
  roots.push(root)
  const schemaContracts: Record<string, Record<string, string>> = {}
  const bodies = new Map<string, string>()
  for (const factory of Object.values(SOURCE_STATE_FACTORIES)) {
    // Several factories share a file, so build each file from all its markers.
    const existing = bodies.get(factory.path) ?? ''
    bodies.set(factory.path, `${existing}${factory.start}(options) {\n  return ${factory.semanticId}\n}\n`) // F1.469: a real factory's column-0 `}`
  }
  for (const [path, body] of bodies) write(root, path, body)
  for (const factory of Object.values(SOURCE_STATE_FACTORIES)) {
    const source = readFileSync(resolve(root, factory.path), 'utf8')
    const start = source.indexOf(factory.start)
    const end = factory.end ? source.indexOf(factory.end, start + factory.start.length) : source.length
    const digest = digestOf(factory.path, source.slice(start, end))
    // P2.235 — `bindingSchemaVersion` carries the TOOL'S OWN NAME and
    // `handlerSchemaVersion` the factory's path and function. Both were `x` and
    // absent respectively while the gate read only the hex; now that it compares
    // whole strings, the fixture has to be as real as the pin it stands for.
    const currentName = Object.entries(SOURCE_STATE_FACTORIES)
      .find(([, entry]) => entry.semanticId === factory.semanticId)?.[0] as string
    schemaContracts[factory.semanticId] = {
      evidenceKind: 'source-state-schema',
      schemaIdentity: `source-state-schema:sha256:${digest}`,
      modelSchemaVersion: `source-state-schema/sha256:${digest}`,
      bindingSchemaVersion: `exact-name:${currentName}/sha256:${digest}`,
      handlerSchemaVersion: `${factory.path}#${factory.start.replace(/^export function\s+/, '')}.execute@${'e'.repeat(40)}`,
    }
  }
  for (const [id, value] of Object.entries(options.extraContracts ?? {})) {
    schemaContracts[id] = { ...value, schemaIdentity: '', modelSchemaVersion: '', bindingSchemaVersion: '' }
  }
  // P2.235 — the fixture's ROW collections, which are what the structural half
  // derives each pin's name and handler from. Without them every contract would
  // report `(row)` and the synthetic repo would say nothing about the checks.
  const piStaticTools = Object.entries(SOURCE_STATE_FACTORIES).map(([currentName, factory]) => ({
    semanticId: factory.semanticId,
    currentName,
    handlerName: `${factory.start.replace(/^export function\s+/, '')}.execute`,
  }))
  write(root, SOURCE_STATE_FIXTURE, JSON.stringify({ schemaContracts, piStaticTools }, null, 2))
  return root
}

function fixtureOf(root: string): any {
  return JSON.parse(readFileSync(resolve(root, SOURCE_STATE_FIXTURE), 'utf8'))
}

function writeFixture(root: string, fixture: unknown): void {
  write(root, SOURCE_STATE_FIXTURE, JSON.stringify(fixture, null, 2))
}

describe('P2.116 source-state contract gate', () => {
  test('a synthetic repo whose pins match its source reports no drift (positive control)', () => {
    const root = makeRoot()
    expect(collectSourceStateDrift(root)).toEqual([])
    // The control has to be able to FAIL, or it proves nothing: move the source.
    write(root, REVIEW.path, `${readFileSync(resolve(root, REVIEW.path), 'utf8')}// moved\n`)
    expect(collectSourceStateDrift(root)).not.toEqual([])
  })

  test('I3 — ONE corrupted field of three is caught, and named as a hand-edit', () => {
    const root = makeRoot()
    const fixture = fixtureOf(root)
    const pin = fixture.schemaContracts[REVIEW.semanticId]
    pin.modelSchemaVersion = pin.modelSchemaVersion.replace(/:([0-9a-f])/, (_: string, c: string) => `:${c === 'a' ? 'b' : 'a'}`)
    writeFixture(root, fixture)

    const drift = collectSourceStateDrift(root)
    expect(drift).toHaveLength(1)
    expect(drift[0]!.semanticId).toBe(REVIEW.semanticId)
    // The whole point of I3: reading `schemaIdentity` alone would report 0 rows.
    expect(drift[0]!.mismatched).toEqual(['modelSchemaVersion'])
    expect(drift[0]!.stored.schemaIdentity).toBe(drift[0]!.live)
    expect(pinIsInternallyInconsistent(drift[0]!)).toBe(true)
  })

  test('a moved SOURCE moves all three fields together, and is NOT a hand-edit', () => {
    const root = makeRoot()
    write(root, REVIEW.path, `${readFileSync(resolve(root, REVIEW.path), 'utf8')}// an implementation edit\n`)
    const drift = collectSourceStateDrift(root)
    const row = drift.find(entry => entry.semanticId === REVIEW.semanticId)!
    expect(row.mismatched).toEqual([...DIGEST_FIELDS])
    // The discriminating half: drift and hand-edit must not collapse into one.
    expect(pinIsInternallyInconsistent(row)).toBe(false)
  })

  test('a deleted pin field refuses by name — for EVERY digest field, not just the first', () => {
    for (const field of DIGEST_FIELDS) {
      const root = makeRoot()
      const fixture = fixtureOf(root)
      delete fixture.schemaContracts[REVIEW.semanticId][field]
      writeFixture(root, fixture)
      expect(() => collectSourceStateDrift(root)).toThrow(new RegExp(`${field}.*is missing`))
      expect(() => collectSourceStateDrift(root)).toThrow(SourceStateGateRefusal)
    }
  })

  test('a renamed factory refuses by name rather than silently skipping the tool', () => {
    const root = makeRoot()
    const source = readFileSync(resolve(root, REVIEW.path), 'utf8')
    write(root, REVIEW.path, source.replace(REVIEW.start, 'export function buildReviewTool'))
    expect(() => collectSourceStateDrift(root)).toThrow(/start marker .* not found/)
    expect(() => collectSourceStateDrift(root)).toThrow(SourceStateGateRefusal)
  })

  test('--pin rewrites a genuine drift in all three fields, and refuses a hand-edit', () => {
    const root = makeRoot()
    write(root, REVIEW.path, `${readFileSync(resolve(root, REVIEW.path), 'utf8')}// moved\n`)
    const [row] = collectSourceStateDrift(root).filter(entry => entry.semanticId === REVIEW.semanticId)
    rewritePin(root, row!)
    expect(collectSourceStateDrift(root)).toEqual([])
    const rewritten = fixtureOf(root).schemaContracts[REVIEW.semanticId]
    for (const field of DIGEST_FIELDS) expect(rewritten[field]).toContain(row!.live)

    const handEdited = makeRoot()
    const fixture = fixtureOf(handEdited)
    const pin = fixture.schemaContracts[REVIEW.semanticId]
    pin.bindingSchemaVersion = pin.bindingSchemaVersion.slice(0, -1) + (pin.bindingSchemaVersion.endsWith('a') ? 'b' : 'a')
    writeFixture(handEdited, fixture)
    const [inconsistent] = collectSourceStateDrift(handEdited).filter(entry => entry.semanticId === REVIEW.semanticId)
    expect(() => rewritePin(handEdited, inconsistent!)).toThrow(/DIFFERENT digests/)
    // Refusing means refusing: the fixture is untouched.
    expect(fixtureOf(handEdited).schemaContracts[REVIEW.semanticId]).toEqual(pin)
  })

  test('I1 + I2 — the RED report never claims model-facing, and states its own coverage', () => {
    const root = makeRoot()
    write(root, REVIEW.path, `${readFileSync(resolve(root, REVIEW.path), 'utf8')}// moved\n`)
    const drift = collectSourceStateDrift(root)
    const report = renderDriftReport(root, drift, Object.keys(SOURCE_STATE_FACTORIES).length).join('\n')

    // I1: the headline is the deliverable. It must not assert the misconception
    // this row exists to kill.
    expect(report).toContain('pinned FACTORY SOURCE')
    expect(report).not.toContain('model-facing tool surface')
    // I2: the caveat has to be on the path a lane actually reads.
    expect(report).toContain('Coverage:')
    expect(report).toContain('schemaContracts')
  })

  test('F1 — the coverage sentence counts source-text pins as source-text, wherever they live', () => {
    // A `dynamic-wire-source` pin is hashed from source regions, so it is the SAME
    // class as the six factories. Calling it "live-derived" was the defect this
    // pins. P6.877 made `mcp.dynamic` itself a COVERED pin, so the unread example
    // here is a hypothetical eighth of the class — which is exactly the case the
    // sentence has to keep catching: a source-text pin nobody wired in.
    expect(SOURCE_TEXT_EVIDENCE_KINDS).toContain('dynamic-wire-source')
    expect(SOURCE_STATE_COVERED_SEMANTIC_IDS).not.toContain('other.wire')
    const root = makeRoot({
      extraContracts: {
        'some.live': { evidenceKind: 'live-json-schema' },
        'other.wire': { evidenceKind: 'dynamic-wire-source' },
      },
    })
    const census = censusSchemaContracts(root)
    expect(census.total).toBe(8)
    expect(census.sourceText).toContain('other.wire')
    expect(census.liveDerived).toEqual(['some.live'])

    const line = coverageLine(root, Object.keys(SOURCE_STATE_FACTORIES).length)
    expect(line).toContain('other.wire')
    expect(line).toContain('NOT live-derived')
    // And the honest arithmetic: 1 live-derived unread, not 2.
    expect(line).toContain('1 are live-derived')
  })

  /**
   * P2.235 — the gate read the HEX and threw the prefixes away, and three
   * separate hazards lived in what it threw away.
   */
  describe('P2.235 — the whole pinned string, not the digest inside it', () => {
    test('a right digest under a CORRUPTED PREFIX is caught, and named as a prefix problem', () => {
      const root = makeRoot()
      const fixture = fixtureOf(root)
      const pin = fixture.schemaContracts[REVIEW.semanticId]
      // The measured hole: relabel the prefix, keep the digest. Before this row
      // the gate reported `6/6 match live source, all 3 digest fields each`.
      pin.schemaIdentity = pin.schemaIdentity.replace('source-state-schema:', 'live-json-schema:')
      writeFixture(root, fixture)

      const drift = collectSourceStateDrift(root)
      const row = drift.find(entry => entry.semanticId === REVIEW.semanticId)
      expect(row, 'a corrupted prefix must still be drift').toBeDefined()
      // The digest half is untouched — which is exactly why the old gate passed.
      expect(row!.mismatched).toEqual([])
      expect(row!.mismatchedFull).toEqual(['schemaIdentity'])
      expect(renderDriftReport(root, drift, 6).join('\n')).toContain('PREFIX/VALUE schemaIdentity')
    })

    test('`bindingSchemaVersion` carrying the WRONG TOOL NAME is caught', () => {
      const root = makeRoot()
      const fixture = fixtureOf(root)
      const pin = fixture.schemaContracts[REVIEW.semanticId]
      pin.bindingSchemaVersion = pin.bindingSchemaVersion.replace('exact-name:review/', 'exact-name:renamed/')
      writeFixture(root, fixture)
      const row = collectSourceStateDrift(root).find(entry => entry.semanticId === REVIEW.semanticId)
      expect(row!.mismatchedFull).toEqual(['bindingSchemaVersion'])
    })

    test('`handlerSchemaVersion` naming a path or handler that moved is caught — the field the gate never read', () => {
      for (const [label, from, to] of [
        ['path', REVIEW.path, 'packages/pi-agent-server/src/orchestrator/moved-review-tool.ts'],
        ['handler', 'createReviewTool.execute', 'buildReviewTool.execute'],
      ] as const) {
        const root = makeRoot()
        const fixture = fixtureOf(root)
        const pin = fixture.schemaContracts[REVIEW.semanticId]
        pin.handlerSchemaVersion = pin.handlerSchemaVersion.replace(from, to)
        writeFixture(root, fixture)
        const row = collectSourceStateDrift(root).find(entry => entry.semanticId === REVIEW.semanticId)
        expect(row!.mismatchedFull, label).toEqual(['handlerSchemaVersion'])
      }
    })

    test('the `@<commit>` suffix is carried through rather than invented', () => {
      // Nothing here can derive it, and a rewrite that guessed would be writing a
      // provenance nobody chose. Only its SHAPE is the gate's business.
      const root = makeRoot()
      const row = collectSourceStateDrift(root)
      expect(row).toEqual([])
      expect(PIN_FIELDS).toContain('handlerSchemaVersion')
    })

    test('--pin rewrites the WHOLE field, so a stale prefix cannot survive a re-pin', () => {
      const root = makeRoot()
      const fixture = fixtureOf(root)
      const pin = fixture.schemaContracts[REVIEW.semanticId]
      // The `--pin`-manufactured state: a tool renamed, so the digest moves AND
      // the name inside `bindingSchemaVersion` is stale. Rewriting only the hex
      // left the stale name behind and the gate then called it green.
      pin.bindingSchemaVersion = pin.bindingSchemaVersion.replace('exact-name:review/', 'exact-name:oldname/')
      writeFixture(root, fixture)
      write(root, REVIEW.path, `${readFileSync(resolve(root, REVIEW.path), 'utf8')}// moved\n`)

      const row = collectSourceStateDrift(root).find(entry => entry.semanticId === REVIEW.semanticId)
      rewritePin(root, row!)
      expect(collectSourceStateDrift(root)).toEqual([])
      expect(fixtureOf(root).schemaContracts[REVIEW.semanticId].bindingSchemaVersion).toContain('exact-name:review/')
      expect(fixtureOf(root).schemaContracts[REVIEW.semanticId].bindingSchemaVersion).not.toContain('oldname')
    })

    test('the uncovered pins are NAMED, and the covered ones are not among them', () => {
      const root = makeRoot({
        extraContracts: {
          'some.live': { evidenceKind: 'live-json-schema' },
          'mcp.dynamic': { evidenceKind: 'dynamic-wire-source' },
        },
      })
      const unread = unreadSemanticIds(root)
      // Positive control: the list is non-empty and is the complement of the
      // COVERED set — which is seven since P6.877, not the six factories, so a
      // pin can never be both read and listed as unread.
      expect(unread).toEqual(['some.live'])
      for (const semanticId of SOURCE_STATE_COVERED_SEMANTIC_IDS) {
        expect(unread).not.toContain(semanticId)
      }
      expect(unread.length + SOURCE_STATE_COVERED_SEMANTIC_IDS.length).toBe(censusSchemaContracts(root).total)
    })

    test('P2.235(d) — the unread-source-text sentence survives relabelling a COVERED pin', () => {
      // `unreadSourceText` used to be a SUBTRACTION, so relabelling the
      // `evidenceKind` of one of the six — a field the gate never reads — made
      // this whole sentence vanish while `mcp.dynamic` stayed unread.
      // The unread source-text pin is a hypothetical one since P6.877 covered
      // `mcp.dynamic`; the hazard is the arithmetic, not which name carries it.
      const root = makeRoot({ extraContracts: { 'other.wire': { evidenceKind: 'dynamic-wire-source' } } })
      expect(coverageLine(root, 6)).toContain('other.wire')
      const fixture = fixtureOf(root)
      fixture.schemaContracts[REVIEW.semanticId].evidenceKind = 'live-json-schema'
      writeFixture(root, fixture)
      expect(coverageLine(root, 6)).toContain('other.wire')
      expect(coverageLine(root, 6)).toContain('NOT live-derived')
      // And the NUMBER, not only the sentence. Under the old subtraction this
      // reads `0 unread` while one name is printed beside it — a line that
      // disagrees with itself, which is how the count was wrong for so long.
      expect(coverageLine(root, 6)).toContain('The remaining 1 unread')
    })
  })

  /**
   * P2.255 — the mitigation, and the reason it needs its own cases.
   *
   * The CLI now re-checks I1/I2/I3 against its OWN rendered output before
   * printing, so those three survive on `bun run typecheck` rather than only on
   * root `bun test`. A self-check exercised solely on output that already
   * satisfies it proves nothing, so every branch is driven from the negative
   * side too.
   */
  describe('P2.255 — the report-shape self-check the CLI runs on the fast path', () => {
    const covered = Object.keys(SOURCE_STATE_FACTORIES).length
    const goodRed = (root: string): string =>
      renderDriftReport(root, collectSourceStateDrift(root), covered).join('\n')
    const goodGreen = (root: string): string => renderGreenReport(root, covered).join('\n')

    function driftedRoot(): string {
      const root = makeRoot()
      write(root, REVIEW.path, `${readFileSync(resolve(root, REVIEW.path), 'utf8')}// moved\n`)
      return root
    }

    test('passes on the reports this file really renders', () => {
      const root = driftedRoot()
      expect(describeReportShapeFailure(goodRed(root), goodGreen(root))).toBeNull()
      expect(reportShapeSelfCheckFailure(root, covered)).toBeNull()
    })

    test('I1 — a headline that loses the FACTORY SOURCE wording, or claims model-facing, is named', () => {
      const root = driftedRoot()
      const green = goodGreen(root)
      expect(describeReportShapeFailure(goodRed(root).replace('pinned FACTORY SOURCE', 'pinned surface'), green))
        .toMatch(/I1, the headline/)
      expect(describeReportShapeFailure(`${goodRed(root)}\nthe model-facing tool surface moved`, green))
        .toMatch(/I1 inverted/)
    })

    test('I2 — the caveat is required on BOTH paths, and each is named separately', () => {
      const root = driftedRoot()
      expect(describeReportShapeFailure(goodRed(root).replace('Coverage:', 'coverage:'), goodGreen(root)))
        .toMatch(/^the red-path report dropped the coverage caveat/)
      expect(describeReportShapeFailure(goodRed(root), goodGreen(root).replace('Coverage:', 'coverage:')))
        .toMatch(/^the green-path report dropped the coverage caveat/)
    })

    test('I3 — a report narrowed back to one digest field names the two it dropped', () => {
      const root = driftedRoot()
      // Every line that NAMES either field, not just the digest lines: since
      // P2.235 the red report also prints a `PREFIX/VALUE <field>:` block, so a
      // filter aimed only at the digest lines leaves both names in the report and
      // the self-check correctly answers null — which is a green run over a
      // mutation that did not happen, the thing this whole file exists to avoid.
      const narrowed = goodRed(root)
        .split('\n')
        .filter(line => !/modelSchemaVersion|bindingSchemaVersion/.test(line))
        .join('\n')
      const failure = describeReportShapeFailure(narrowed, goodGreen(root))
      expect(failure).toMatch(/I3/)
      expect(failure).toContain('modelSchemaVersion')
      expect(failure).toContain('bindingSchemaVersion')
      // The positive control for the filter: it really removed those lines and
      // left `schemaIdentity`, so the assertion above is about the check and
      // not about a filter that emptied the string.
      expect(narrowed).toContain('schemaIdentity')
    })
  })
})

/**
 * P2.235 — "the digest gate over all 78 pins", in the half that needs no Pi
 * runtime graph.
 *
 * The three hazards this row catalogued are all properties of the STORED
 * STRINGS: a right digest under a stale `exact-name:` prefix (which `--pin`
 * manufactures rather than merely tolerates), the three digest fields
 * disagreeing with one another, and a `handlerSchemaVersion` naming a file or a
 * handler that no longer exists. Those were checked for six pins and unchecked
 * for seventy-two, and none of them needs a live import to check.
 *
 * Every case below is a MUTANT against a synthetic repo, because the live
 * fixture is a file other lanes hold: the guard is only worth its line count if
 * each check can be shown to go red on its own, and the live-tree case at the
 * end is the positive control that the same code reads the real fixture.
 */
describe('P2.235 pin structure — all pins, not the six', () => {
  const structureOf = (root: string): string[] =>
    collectPinStructureFindings(root).map(finding => `${finding.semanticId}·${finding.field}`)

  test('a synthetic repo whose pins agree with their own rows reports nothing', () => {
    expect(structureOf(makeRoot())).toEqual([])
  })

  test('a stale exact-name prefix under a RIGHT digest is caught', () => {
    const root = makeRoot()
    const fixture = fixtureOf(root)
    const pin = fixture.schemaContracts[REVIEW.semanticId]
    // The `--pin` shape exactly: the hex is untouched, the name is yesterday's.
    pin.bindingSchemaVersion = pin.bindingSchemaVersion.replace('exact-name:review/', 'exact-name:reviewOld/')
    writeFixture(root, fixture)
    // The digest half stays silent on it, which is the point of the row.
    expect(collectSourceStateDrift(root).map(row => row.semanticId)).toContain(REVIEW.semanticId)
    expect(structureOf(root)).toEqual([`${REVIEW.semanticId}·bindingSchemaVersion`])
    expect(collectPinStructureFindings(root)[0]?.expected).toContain('exact-name:review/')
  })

  test('the same stale prefix on a pin the DIGEST half does not read is caught too', () => {
    // The whole widening in one case: `session.*` pins are live-derived, so
    // `collectSourceStateDrift` never looks at them, and before this check a
    // renamed session tool left a stale `exact-name:` behind for good.
    const root = makeRoot()
    const fixture = fixtureOf(root)
    const digest = 'c'.repeat(64)
    fixture.schemaContracts['session.example'] = {
      evidenceKind: 'live-json-schema',
      schemaIdentity: `live-json-schema:sha256:${digest}`,
      modelSchemaVersion: `live-json-schema/sha256:${digest}`,
      bindingSchemaVersion: `exact-name:mcp__session__Old/sha256:${digest}`,
      handlerSchemaVersion: `${REVIEW.path}#Example@${'e'.repeat(40)}`,
    }
    fixture.piStaticTools.push({
      semanticId: 'session.example', currentName: 'mcp__session__New', handlerName: 'Example',
    })
    writeFixture(root, fixture)
    expect(collectSourceStateDrift(root).map(row => row.semanticId)).not.toContain('session.example')
    expect(structureOf(root)).toEqual(['session.example·bindingSchemaVersion'])
  })

  test('an evidenceKind that disagrees with its own schemaIdentity prefix is caught', () => {
    const root = makeRoot()
    const fixture = fixtureOf(root)
    fixture.schemaContracts[REVIEW.semanticId].evidenceKind = 'live-json-schema'
    writeFixture(root, fixture)
    expect(structureOf(root)).toEqual([`${REVIEW.semanticId}·schemaIdentity`])
  })

  test('a handlerSchemaVersion naming a moved file, or another handler, is caught', () => {
    const moved = makeRoot()
    const movedFixture = fixtureOf(moved)
    movedFixture.schemaContracts[REVIEW.semanticId].handlerSchemaVersion =
      `packages/gone/nowhere.ts#createReviewTool.execute@${'e'.repeat(40)}`
    writeFixture(moved, movedFixture)
    expect(structureOf(moved)).toEqual([`${REVIEW.semanticId}·handlerSchemaVersion`])

    const renamed = makeRoot()
    const renamedFixture = fixtureOf(renamed)
    renamedFixture.schemaContracts[REVIEW.semanticId].handlerSchemaVersion =
      `${REVIEW.path}#somethingElse@${'e'.repeat(40)}`
    writeFixture(renamed, renamedFixture)
    expect(structureOf(renamed)).toEqual([`${REVIEW.semanticId}·handlerSchemaVersion`])
  })

  test('a row with no pin, and a pin with no row, are both findings', () => {
    const orphanRow = makeRoot()
    const rowFixture = fixtureOf(orphanRow)
    rowFixture.piStaticTools.push({ semanticId: 'agent.unpinned', currentName: 'x', handlerName: 'y' })
    writeFixture(orphanRow, rowFixture)
    expect(structureOf(orphanRow)).toEqual(['agent.unpinned·(contract)'])

    const orphanPin = makeRoot()
    const pinFixture = fixtureOf(orphanPin)
    pinFixture.schemaContracts['agent.rowless'] = { evidenceKind: 'live-json-schema' }
    writeFixture(orphanPin, pinFixture)
    expect(structureOf(orphanPin)).toEqual(['agent.rowless·(row)'])
  })

  test('the LIVE fixture satisfies all of it, over every pin it holds', () => {
    const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..')
    // The positive control: the same call reads the real tree and finds the pins
    // there, so "no findings" is a verdict rather than an empty read.
    expect(censusSchemaContracts(repoRoot).total).toBeGreaterThan(70)
    expect(collectPinStructureFindings(repoRoot)).toEqual([])
  })
})

/**
 * P2.255 — the two self-checks the CLI runs BEFORE it trusts itself, driven in
 * both directions here because a self-check exercised only on output that
 * already satisfies it is indistinguishable from one whose branches were cut.
 */
describe('P2.255 — the gate proving itself on the command a lane runs', () => {
  test('the structure self-check passes on the shipped rule', () => {
    expect(structureSelfCheckFailure()).toBeNull()
  })

  test('I2 — a report that drops the structure line is refused', () => {
    const root = makeRoot()
    const green = renderGreenReport(root, 6).join('\n')
    const red = renderDriftReport(root, [], 6).join('\n')
    expect(green).toContain('Structure:')
    for (const [label, narrowed] of [['red', red], ['green', green]] as const) {
      const stripped = narrowed.split('\n').filter(line => !line.includes('Structure:')).join('\n')
      const failure = label === 'red'
        ? describeReportShapeFailure(`${stripped}\npinned FACTORY SOURCE\n${DIGEST_FIELDS.join(' ')}`, green)
        : describeReportShapeFailure(red, stripped)
      expect(failure).toContain('structure line')
    }
  })
})

/**
 * UB12.14 — I4: the gate that compares no `PI_STATIC_MODEL_CONTRACT_HASHES` pin
 * names, on both paths, the command that does. UB6.11 moved `ask_user`'s pin
 * through `PI_TOOL_PRESENTATION_REWRITES` while this gate, the Session-tools
 * recipe's last step, read green.
 */
describe('UB12.14 — I4, the model-contract pointer on the command the recipe runs', () => {
  const repoRoot = resolve(import.meta.dir, '..', '..', '..', '..')
  const covered = Object.keys(SOURCE_STATE_FACTORIES).length
  /** A REAL red report (one drifted factory), so I1–I3 hold and only I4 is on trial. */
  function reports(): { red: string, green: string } {
    const root = makeRoot()
    write(root, REVIEW.path, `${readFileSync(resolve(root, REVIEW.path), 'utf8')}// moved\n`)
    return {
      red: renderDriftReport(root, collectSourceStateDrift(root), covered).join('\n'),
      green: renderGreenReport(root, covered).join('\n'),
    }
  }

  test('both reports carry the pointer, and its command names a test file that exists', () => {
    const { red, green } = reports()
    for (const text of [green, red]) {
      expect(text).toContain(MODEL_CONTRACT_TEST_COMMAND)
      expect(text).toContain('PI_TOOL_PRESENTATION_REWRITES')
    }
    expect(describeReportShapeFailure(red, green)).toBeNull()
    // Boundary: a pointer at a renamed or moved test is a dead instruction, so the
    // `./` path inside the command must resolve in the real tree.
    const target = /bun test \.\/(\S+)$/.exec(MODEL_CONTRACT_TEST_COMMAND)?.[1]
    expect(target).toBe('packages/pi-agent-server/src/harness/live-manifest-contract.test.ts')
    expect(existsSync(resolve(repoRoot, target!))).toBe(true)
  })

  test('a report that drops the pointer is refused on either path, though the red one still names the test', () => {
    const { red, green } = reports()
    const strip = (text: string): string => {
      const pointer = new Set(modelContractPointerLines())
      return text.split('\n').filter(line => !pointer.has(line)).join('\n')
    }
    // The drift remedy keeps naming live-manifest-contract.test.ts, so a needle of
    // the bare file name would pass a red report the pointer was cut from.
    expect(strip(red)).toContain('live-manifest-contract.test.ts')
    expect(describeReportShapeFailure(strip(red), green)).toMatch(/^the red-path report dropped the model-contract pointer — I4/)
    expect(describeReportShapeFailure(red, strip(green))).toMatch(/^the green-path report dropped the model-contract pointer — I4/)
  })
})

/**
 * P6.818 — the `live-json-schema` half, driven in both directions.
 *
 * The gap it closes was measured, not theoretical: four of these pins sat wrong
 * for days while `check:surface` printed `6/6 match live source`, because the
 * only thing that recomputed them was root `bun test`. The comparator is pure, so
 * a planted digest change can be checked here without a live tool graph — which
 * is the same reason the CLI can self-check before it trusts itself.
 */
describe('P6.818 — the live-json-schema comparator', () => {
  const LIVE = 'c'.repeat(64)
  const DESCRIBED = 'f'.repeat(64)
  const pin = (name: string, digest: string, description = DESCRIBED): Record<string, string> => ({
    evidenceKind: LIVE_JSON_SCHEMA_KIND,
    schemaIdentity: `${LIVE_JSON_SCHEMA_KIND}:sha256:${digest}`,
    modelSchemaVersion: `${LIVE_JSON_SCHEMA_KIND}/sha256:${digest}`,
    bindingSchemaVersion: `exact-name:${name}/sha256:${digest}`,
    [DESCRIPTION_DIGEST_FIELD]: `${LIVE_TOOL_DESCRIPTION_KIND}:sha256:${description}`,
  })
  const rows = new Map([['session.t', { semanticId: 'session.t', currentName: 'mcp__session__T' }]])
  const described = (): string => DESCRIBED

  test('says nothing about a pin that matches the live digest', () => {
    expect(findLiveJsonSchemaFindings(
      rows, { 'session.t': pin('mcp__session__T', LIVE) }, () => LIVE, described,
    )).toEqual([])
  })

  test('a PLANTED digest change is reported, in every digest-bearing field', () => {
    const findings = findLiveJsonSchemaFindings(
      rows, { 'session.t': pin('mcp__session__T', 'd'.repeat(64)) }, () => LIVE, described,
    )
    // All three, not one: reading `schemaIdentity` alone is exactly how an
    // internally inconsistent pin walked past the digest half (P2.235). The
    // description field is NOT among them — its payload did not move, and a
    // report that named it would send the reader to re-pin prose.
    expect(findings.map(finding => finding.field).sort()).toEqual([...DIGEST_FIELDS].sort())
    expect(findings.every(finding => finding.expected.includes(LIVE))).toBe(true)
  })

  test('ignores every pin that is not live-json-schema, so the six stay the digest half’s', () => {
    const sourceState = { evidenceKind: 'source-state-schema', schemaIdentity: 'source-state-schema:sha256:' + 'd'.repeat(64) }
    expect(findLiveJsonSchemaFindings(rows, { 'session.t': sourceState }, () => LIVE, described)).toEqual([])
  })

  test('a pin whose tool left the live surface is a finding, not silence', () => {
    const findings = findLiveJsonSchemaFindings(
      rows, { 'session.t': pin('mcp__session__T', LIVE) }, () => undefined, () => undefined,
    )
    expect(findings.map(finding => finding.field)).toEqual(['(live definition)'])
  })

  test('a pin with no fixture row is a finding — nothing could look its schema up', () => {
    const findings = findLiveJsonSchemaFindings(
      new Map(), { 'session.t': pin('mcp__session__T', LIVE) }, () => LIVE, described,
    )
    expect(findings.map(finding => finding.field)).toEqual(['(row)'])
  })

  /**
   * F1.114 (origin WI-bw) — the half that was blind, driven both ways.
   *
   * The measurement that produced the row: a `.describe()` on one schema field
   * moved two pins, while REWRITING both `automation_*` tool descriptions moved
   * nothing and the suite stayed green. These three arms are that measurement
   * turned into a rule.
   */
  test('a REWORDED tool is reported, on the description field and on that field alone', () => {
    const findings = findLiveJsonSchemaFindings(
      rows, { 'session.t': pin('mcp__session__T', LIVE, 'd'.repeat(64)) }, () => LIVE, described,
    )
    expect(findings.map(finding => finding.field)).toEqual([DESCRIPTION_DIGEST_FIELD])
    expect(findings[0]?.expected).toBe(`${LIVE_TOOL_DESCRIPTION_KIND}:sha256:${DESCRIBED}`)
    expect(findings[0]?.why).toContain('description')
  })

  test('a live-json-schema pin carrying NO description digest is a finding, not coverage', () => {
    const { [DESCRIPTION_DIGEST_FIELD]: _dropped, ...unpinned } = pin('mcp__session__T', LIVE)
    const findings = findLiveJsonSchemaFindings(rows, { 'session.t': unpinned }, () => LIVE, described)
    expect(findings.map(finding => finding.field)).toEqual([DESCRIPTION_DIGEST_FIELD])
    expect(findings[0]?.stored).toBe('(absent)')
    expect(findings[0]?.why).toContain('pinned by nothing')
  })

  test('CONTROL — the description field does not fire when both halves match', () => {
    const findings = findLiveJsonSchemaFindings(
      rows, { 'session.t': pin('mcp__session__T', LIVE) }, () => LIVE, described,
    )
    expect(findings).toEqual([])
  })

  test('the CLI self-check passes on the shipped comparator', () => {
    expect(liveJsonSchemaSelfCheckFailure()).toBeNull()
  })
})

/**
 * P6.877 — the seventh source-text pin, which this file NAMED as unread for two
 * rows before anybody read it.
 *
 * The cases run against the synthetic repo like everything above, plus ONE
 * against the real tree: no synthetic root can show that the derivation
 * reproduces the SHIPPED fixture, and reproducing it byte for byte is the whole
 * requirement — a payload that disagrees with `pi-harness-baseline.test.ts`'s by
 * one character would make this gate go red on a correct fixture.
 */
describe('P6.877 — the dynamic-wire source pin', () => {
  const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

  /** The pin's two regions, its fixture row and a pin that matches them. */
  function withDynamicWire(root: string, overrides: Record<string, string> = {}): string {
    for (const region of DYNAMIC_WIRE_SOURCE_PIN.regions) {
      write(root, region.path, `${region.start} { return '${region.key}' }\n${region.end}\n`)
    }
    const row = {
      semanticId: DYNAMIC_WIRE_SOURCE_PIN.semanticId,
      currentName: 'mcp__server__tool',
      bindingPattern: 'mcp__<server>__<tool>',
      handlerName: 'McpClientPool.callTool',
      ...overrides,
    }
    const digest = dynamicWireSourcePayloadDigest(dynamicWireSourcePayload(root, row.bindingPattern))
    const fixture = fixtureOf(root)
    fixture.dynamicMcp = row
    fixture.schemaContracts[DYNAMIC_WIRE_SOURCE_PIN.semanticId] = {
      evidenceKind: 'dynamic-wire-source',
      schemaIdentity: `dynamic-wire-source:sha256:${digest}`,
      modelSchemaVersion: `dynamic-wire-source/sha256:${digest}`,
      bindingSchemaVersion: `exact-name:${row.currentName}/sha256:${digest}`,
      handlerSchemaVersion: `${DYNAMIC_WIRE_SOURCE_PIN.handlerSource}#${row.handlerName}@${'e'.repeat(40)}`,
    }
    writeFixture(root, fixture)
    return root
  }

  test('the SHIPPED fixture is reproduced from source text alone (the load-bearing case)', () => {
    // If the payload here and the baseline test's ever diverge, this is what says
    // so — on `bun run typecheck` in this package rather than at merge.
    expect(collectDynamicWireSourceDrift(REPO_ROOT)).toEqual([])
  })

  test('a planted change in the SECOND region is drift — a one-region pin would miss it', () => {
    const root = withDynamicWire(makeRoot())
    expect(collectDynamicWireSourceDrift(root)).toEqual([])

    const second = DYNAMIC_WIRE_SOURCE_PIN.regions[1]!
    write(root, second.path, readFileSync(resolve(root, second.path), 'utf8').replace(second.end, `// planted\n${second.end}`))
    const drift = collectDynamicWireSourceDrift(root)
    expect(drift).toHaveLength(1)
    expect(drift[0]!.semanticId).toBe('mcp.dynamic')
    // All three digest fields, never one — P2.235 applies to this pin identically.
    expect([...drift[0]!.mismatched].sort()).toEqual([...DIGEST_FIELDS].sort())
    // And the report names BOTH regions, so the reader is not sent to one file.
    for (const region of DYNAMIC_WIRE_SOURCE_PIN.regions) expect(drift[0]!.path).toContain(region.path)
  })

  test('a RENAME with untouched source moves only bindingSchemaVersion', () => {
    const root = withDynamicWire(makeRoot())
    const fixture = fixtureOf(root)
    fixture.dynamicMcp.currentName = 'mcp__server__renamed'
    writeFixture(root, fixture)
    const drift = collectDynamicWireSourceDrift(root)
    expect(drift).toHaveLength(1)
    // The digests still agree with the source — this is the shape a digest-only
    // gate is structurally blind to.
    expect(drift[0]!.mismatched).toEqual([])
    expect(drift[0]!.mismatchedFull).toEqual(['bindingSchemaVersion'])
  })

  test('--pin repairs it through the SAME rewrite as the six', () => {
    const root = withDynamicWire(makeRoot())
    const second = DYNAMIC_WIRE_SOURCE_PIN.regions[1]!
    write(root, second.path, readFileSync(resolve(root, second.path), 'utf8').replace(second.end, `// planted\n${second.end}`))
    rewritePin(root, collectDynamicWireSourceDrift(root)[0]!)
    expect(collectDynamicWireSourceDrift(root)).toEqual([])
    // The name inside the prefix survived the rewrite (P2.235's manufactured state).
    expect(fixtureOf(root).schemaContracts['mcp.dynamic'].bindingSchemaVersion)
      .toContain('exact-name:mcp__server__tool/')
  })

  test('a DELETED pin or a deleted row refuses — absence must not read as coverage', () => {
    const noPin = withDynamicWire(makeRoot())
    const withoutPin = fixtureOf(noPin)
    delete withoutPin.schemaContracts['mcp.dynamic']
    writeFixture(noPin, withoutPin)
    expect(() => collectDynamicWireSourceDrift(noPin)).toThrow(SourceStateGateRefusal)

    const noRow = withDynamicWire(makeRoot())
    const withoutRow = fixtureOf(noRow)
    delete withoutRow.dynamicMcp.bindingPattern
    writeFixture(noRow, withoutRow)
    expect(() => collectDynamicWireSourceDrift(noRow)).toThrow(SourceStateGateRefusal)
  })

  test('every field of the payload is inside the digest, and the self-check says so', () => {
    expect(dynamicWireSourceSelfCheckFailure()).toBeNull()
    // The same property directly, so a self-check whose loop was deleted is not
    // the only thing asserting it.
    const base = dynamicWireSourcePayload(REPO_ROOT, 'mcp__server__tool')
    const digest = dynamicWireSourcePayloadDigest(base)
    for (const key of Object.keys(base)) {
      expect(dynamicWireSourcePayloadDigest({ ...base, [key]: `${base[key]!}// planted` }), key).not.toBe(digest)
    }
    expect(Object.keys(base).sort()).toEqual(['bindingPattern', 'piProjection', 'poolProjection'])
  })

  test('it is COVERED now, so no coverage sentence may still call it unread', () => {
    expect(SOURCE_STATE_COVERED_SEMANTIC_IDS).toContain('mcp.dynamic')
    expect(unreadSemanticIds(REPO_ROOT)).not.toContain('mcp.dynamic')
    expect(coverageLine(REPO_ROOT, SOURCE_STATE_COVERED_SEMANTIC_IDS.length)).not.toContain('mcp.dynamic')
  })
})

/**
 * P6.1077 — `--pin` used to re-pin a drifted source-state digest and say NOTHING
 * about the model-facing contract, which is how `d0e61e7ff` shipped a `review`
 * that killed every live Pi session on its first turn for a day.
 *
 * The expensive half (`collectModelContractPartings`, which imports the live Pi
 * tool graph — 327 s cold, measured) is NOT driven here: it is a thin adapter
 * over {@link findModelContractPartings}, and the comparator, the refusal and
 * the `--pin` decision are all exercised on plain values. That split is
 * deliberate and is the reason these cases cost milliseconds; what it does not
 * cover is the adapter's own wiring, which `live-manifest-contract.test.ts`
 * covers from the other side by making the same comparison over the whole table.
 */
describe('P6.1077 — `--pin` refuses when the model contract has parted from the pin', () => {
  const PINNED = 'a'.repeat(64)
  const MOVED = 'b'.repeat(64)
  const parting = {
    composition: 'live+session',
    bindingName: 'review',
    pinKey: 'review',
    pinned: PINNED,
    live: MOVED,
  }

  test('POSITIVE — a parted hash refuses `--pin`, names the tool and BOTH hashes, and nothing is rewritten', async () => {
    const root = makeRoot()
    write(root, REVIEW.path, `${readFileSync(resolve(root, REVIEW.path), 'utf8')}// moved\n`)
    const before = fixtureOf(root).schemaContracts[REVIEW.semanticId]
    const drift = collectSourceStateDrift(root).filter(entry => entry.semanticId === REVIEW.semanticId)
    // The row really is re-pinnable: without the guard this drift is exactly
    // what `--pin` silently rewrote.
    expect(drift).toHaveLength(1)

    const refusal = await pinModelContractRefusal(root, async () => [parting])
    expect(refusal).not.toBeNull()
    const text = refusal!.join('\n')
    expect(text).toContain('review')
    expect(text).toContain(PINNED)
    expect(text).toContain(MOVED)
    // The remedy, not just the verdict: the file the pin is typed into, the
    // fixture row that mirrors it, the rebuild, and the guard that proves it.
    expect(text).toContain('harness-tool-descriptor.ts')
    expect(text).toContain(SOURCE_STATE_FIXTURE)
    expect(text).toContain('electron:build:servers')
    expect(text).toContain('live-manifest-contract.test.ts')
    // Refusing means refusing: the caller returns before `rewritePin`, so the
    // pin the drift named is untouched.
    expect(fixtureOf(root).schemaContracts[REVIEW.semanticId]).toEqual(before)
  })

  test('NEGATIVE — agreeing hashes still pin: no refusal, and the drifted row is rewritten', async () => {
    const root = makeRoot()
    write(root, REVIEW.path, `${readFileSync(resolve(root, REVIEW.path), 'utf8')}// moved\n`)
    const [row] = collectSourceStateDrift(root).filter(entry => entry.semanticId === REVIEW.semanticId)

    expect(await pinModelContractRefusal(root, async () => [])).toBeNull()
    rewritePin(root, row!)
    expect(collectSourceStateDrift(root)).toEqual([])
    for (const field of DIGEST_FIELDS) {
      expect(fixtureOf(root).schemaContracts[REVIEW.semanticId][field]).toContain(row!.live)
    }
  })

  test('the comparator answers in BOTH directions and skips a tool the table does not pin', () => {
    const projection = (bindingName: string, live: string) =>
      ({ composition: 'live+session', bindingName, pinKey: bindingName, live })
    const pins = { agrees: PINNED, parts: PINNED }
    const partings = findModelContractPartings(
      [projection('agrees', PINNED), projection('parts', MOVED), projection('unpinned', MOVED)],
      pins,
    )
    expect(partings.map(entry => entry.bindingName)).toEqual(['parts'])
    expect(partings[0]!.pinned).toBe(PINNED)
    expect(partings[0]!.live).toBe(MOVED)
    // One defect, one finding: the four live compositions carry the same tool.
    expect(findModelContractPartings(
      [projection('parts', MOVED), projection('parts', MOVED)],
      pins,
    )).toHaveLength(1)
    // And a different composition IS a separate report, because a pin can be
    // composition-dependent (fork mode carries its own `subagent` pin).
    expect(findModelContractPartings(
      [projection('parts', MOVED), { ...projection('parts', MOVED), composition: 'fork-mode+session' }],
      pins,
    )).toHaveLength(2)
  })

  test('the self-check passes, and it is the same one `check:surface` runs before the comparison', () => {
    expect(modelContractSelfCheckFailure()).toBeNull()
  })

  /**
   * The WIRING, which nothing else here can see: every case above drives
   * {@link pinModelContractRefusal} directly, so a `--pin` branch that stopped
   * calling it would leave all of them green while restoring the exact silence
   * P6.1077 exists to end. A source-text assertion is the honest instrument —
   * the alternative is driving `run()`, which on a synthetic root refuses on the
   * dynamic-wire pin the fixture here does not carry, and on the real root
   * returns before the pin branch because there is no drift.
   */
  test('the `--pin` branch calls the guard BEFORE it rewrites anything', () => {
    const source = readFileSync(resolve(import.meta.dir, 'source-state-contract.ts'), 'utf8')
    const branch = source.slice(source.indexOf('\n  if (pin) {'))
    const guard = branch.indexOf('await pinModelContractRefusal(repoRoot)')
    const rewrite = branch.indexOf('rewritePin(repoRoot, row)')
    expect(guard, 'the --pin branch no longer calls the model-contract guard at all').toBeGreaterThan(-1)
    expect(rewrite).toBeGreaterThan(-1)
    expect(guard, 'the guard runs AFTER the rewrite, so it would report a state it had just created')
      .toBeLessThan(rewrite)
    // And it must refuse rather than warn: a non-zero exit is the whole point.
    expect(branch.slice(guard, rewrite)).toContain('return 1')
  })
})

/**
 * D1.119 — the two halves the `--pin` guard did not cover: every PINNED tool
 * rather than the six this gate re-pins, and the BUILT bundles.
 *
 * The widening itself cannot be driven here — `collectModelContractPartings`
 * imports the live Pi tool graph, measured at 327 s cold — so it is pinned the
 * way this file already pins the `--pin` wiring: over the source text, with the
 * defect's exact former shape named. The bundle half needs no such apology: it
 * is a pure function over a table and a string, with the reader injected.
 */
describe('D1.119 — the whole pinned table, and the bundles that would RUN', () => {
  const PINS = { review: 'a'.repeat(64), bash: 'b'.repeat(64) }

  test('a bundle missing a current pin is reported, by the name that moved', () => {
    const stale = findStaleBundles('/repo', PINS, path =>
      path.endsWith('dist/index.js') ? `embedded ${PINS.review}` : `embedded ${PINS.review} ${PINS.bash}`)
    expect(stale).toHaveLength(1)
    expect(stale[0]!.path).toBe('packages/pi-agent-server/dist/index.js')
    expect(stale[0]!.missing).toEqual(['bash'])
  })

  test('CONTROL — a bundle carrying every pin is not a finding, and both paths are read', () => {
    const seen: string[] = []
    const stale = findStaleBundles('/repo', PINS, path => {
      seen.push(path)
      return `${PINS.review} ${PINS.bash}`
    })
    expect(stale).toEqual([])
    // Two bundles, and the count comes from the exported list rather than a
    // number typed here, so adding a third cannot leave this case behind.
    expect(seen).toHaveLength(BUILT_PI_BUNDLE_PATHS.length)
    expect(BUILT_PI_BUNDLE_PATHS.length).toBe(2)
  })

  test('an ABSENT bundle is not a finding — not every checkout has built one', () => {
    expect(findStaleBundles('/repo', PINS, () => null)).toEqual([])
  })

  test('the note names the live failure and the rebuild, and says nothing when clean', () => {
    expect(renderStaleBundleNote([])).toEqual([])
    const note = renderStaleBundleNote([{ path: 'dist/index.js', missing: ['bash'] }]).join('\n')
    expect(note).toContain('BUILT BUNDLE STALE')
    expect(note).toContain('Pi execution manifest model contract')
    expect(note).toContain('bun run electron:build:servers')
    expect(note).toContain('bash')
  })

  test('the WIRING: both branches report it, and `--pin` does so AFTER the rewrite', () => {
    const source = readFileSync(resolve(import.meta.dir, 'source-state-contract.ts'), 'utf8')
    const run = source.slice(source.indexOf('async function run('))
    // The green branch: source clean, so this is the only place a lane hears
    // that what would RUN is not.
    const green = run.indexOf('renderGreenReport(repoRoot, total)')
    const greenNote = run.indexOf('renderStaleBundleNote', green)
    expect(green).toBeGreaterThan(-1)
    expect(greenNote).toBeGreaterThan(green)
    // The `--pin` branch: after `rewritePin`, because a legitimate re-pin is
    // what MAKES the bundle stale — a refusal there could never be satisfied.
    const rewrite = run.indexOf('rewritePin(repoRoot, row)')
    const pinNote = run.indexOf('renderStaleBundleNote', rewrite)
    expect(rewrite).toBeGreaterThan(-1)
    expect(pinNote).toBeGreaterThan(rewrite)
  })

  test('the model-contract comparison no longer filters to the six factories', () => {
    // The former shape, named exactly: `if (!covered.has(bindingName)) continue`
    // inside the projection loop meant a parting on `bash`, `read` or any of the
    // other fifteen pinned tools was invisible to every command a lane runs.
    const source = readFileSync(resolve(import.meta.dir, 'source-state-contract.ts'), 'utf8')
    const collect = source.slice(source.indexOf('export async function collectModelContractPartings('))
    // CODE only. A guard that cannot tell code from the prose beside it fires on
    // the comment explaining the removal — measured here, on this case's own
    // first run (AGENTS.md §Traps says the same thing about a corrected anchor).
    const body = collect
      .slice(0, collect.indexOf('\nexport '))
      .split('\n')
      .filter(line => !line.trim().startsWith('//'))
      .join('\n')
    expect(body).not.toContain('covered.has(bindingName)')
    // `covered` survives for ONE job — the refusal that a factory pin would
    // otherwise be compared against nothing — and this is what says so.
    expect(body).toContain('const unreached = [...covered].filter')
  })
})
