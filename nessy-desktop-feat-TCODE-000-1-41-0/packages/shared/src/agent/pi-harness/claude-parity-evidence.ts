export const CLAUDE_PARITY_EVIDENCE_VERSION = 1 as const

export type ClaudeParityLane = 'core' | 'desktop'
export type ClaudeParityScore = 0 | 0.5 | 1
export type ClaudeParityDisposition = 'required' | 'accepted-difference'

export interface ClaudeParityOutcomeV1 {
  id: string
  lane: ClaudeParityLane
  domain: string
  weight: number
  currentScore: ClaudeParityScore
  targetScore: ClaudeParityScore
  disposition: ClaudeParityDisposition
  acceptanceReason?: string
  targetPhase: string
  sourceRefs: readonly string[]
  observables: readonly string[]
}

export interface ClaudeParityEvidenceV1 {
  schemaVersion: typeof CLAUDE_PARITY_EVIDENCE_VERSION
  snapshotDate: string
  targets: readonly {
    id: string
    boundary: string
    source: string
  }[]
  scoring: {
    values: readonly ClaudeParityScore[]
    aheadCap: 1
    excludedNonGoals: true
  }
  outcomes: readonly ClaudeParityOutcomeV1[]
  exclusions: readonly string[]
  runtimeIntake: {
    installedVersion: string
    candidateVersion: string
    candidateGitHead: string
    candidateLicense: string
    candidateNode: string
    packages: readonly string[]
    approvedRegistryAvailability: Record<string, 'available' | 'not-available'>
    decision: 'stay-installed' | 'upgrade'
    reason: string
  }
  expectedScore: ClaudeParityReportV1
}

export interface ClaudeParityLaneScoreV1 {
  weight: number
  currentPoints: number
  targetPoints: number
  currentPercentage: number
  targetPercentage: number
}

export interface ClaudeParityReportV1 {
  core: ClaudeParityLaneScoreV1
  desktop: ClaudeParityLaneScoreV1
  combined: ClaudeParityLaneScoreV1
}

export interface ClaudeDesktopEvidenceIndexV1 {
  schemaVersion: 1
  snapshotDate: string
  targets: readonly {
    id: 'claude-code-on-desktop-docs-2026-07-22' | 'claude-desktop-mcpb-docs-2026-07-22'
    source: string
  }[]
  cases: readonly {
    id: string
    targetId: ClaudeDesktopEvidenceIndexV1['targets'][number]['id']
    outcomeId: string
    status: 'implemented' | 'partial' | 'missing' | 'accepted-difference'
    evidenceRefs: readonly string[]
    liveSmoke: {
      status: 'pending' | 'passed'
      scenario: string
      evidenceRefs: readonly string[]
    }
  }[]
}

const STABLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SCORES = new Set<ClaudeParityScore>([0, 0.5, 1])
const EXPECTED_LANE_WEIGHTS: Record<ClaudeParityLane, number> = { core: 80, desktop: 20 }
const REQUIRED_TARGETS = new Set([
  'claude-code-cli-sdk',
  'claude-code-on-desktop',
  'claude-desktop-mcpb',
])
/**
 * Pi 0.84 split the runtime into seven packages — `pi-coding-agent` gained
 * `pi-client` and `pi-protocol` as direct dependencies alongside `pi-tui`, and
 * both `pi-ai` and `pi-agent-core` gained `pi-telemetry`. 0.85 added an eighth,
 * `chord`, a direct dependency of `pi-coding-agent` (and moved `pi-client` /
 * `pi-protocol` to its devDependencies — still published, same gitHead). They
 * ship in lockstep, so the intake record has to cover all eight or it
 * understates the family it claims to have qualified (F1.255, 2026-09-24).
 */
const REQUIRED_PI_PACKAGES = new Set([
  '@earendil-works/chord',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-client',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-protocol',
  '@earendil-works/pi-telemetry',
  '@earendil-works/pi-tui',
])
const REQUIRED_DESKTOP_TARGETS = new Set([
  'claude-code-on-desktop-docs-2026-07-22',
  'claude-desktop-mcpb-docs-2026-07-22',
])
const APPROVED_ACCEPTED_DIFFERENCES = new Set([
  'strict-host-read-isolation',
  'background-cross-version-handoff',
])
const MINIMUM_CLOSEOUT_PERCENTAGES: Record<'core' | 'desktop' | 'combined', number> = {
  core: 90,
  desktop: 85,
  combined: 90,
}
const FORBIDDEN_KEYS = new Set([
  'credential', 'credentials', 'privatetranscript', 'privateprompt', 'requestid',
  'sessionid', 'timestamp', 'toolcallid', 'liveresponse', 'token', 'secret',
])

export function scoreClaudeParityEvidence(
  evidence: Pick<ClaudeParityEvidenceV1, 'outcomes'>,
): ClaudeParityReportV1 {
  for (const outcome of evidence.outcomes) assertOutcomeDisposition(outcome)
  const scoreLane = (lane: ClaudeParityLane): ClaudeParityLaneScoreV1 => {
    const outcomes = evidence.outcomes.filter(outcome => outcome.lane === lane)
    const weight = outcomes.reduce((sum, outcome) => sum + outcome.weight, 0)
    const currentPoints = outcomes.reduce((sum, outcome) => sum + outcome.weight * outcome.currentScore, 0)
    const targetPoints = outcomes.reduce((sum, outcome) => sum + outcome.weight * outcome.targetScore, 0)
    return {
      weight,
      currentPoints,
      targetPoints,
      currentPercentage: percentage(currentPoints, weight),
      targetPercentage: percentage(targetPoints, weight),
    }
  }
  const core = scoreLane('core')
  const desktop = scoreLane('desktop')
  const weight = core.weight + desktop.weight
  const currentPoints = core.currentPoints + desktop.currentPoints
  const targetPoints = core.targetPoints + desktop.targetPoints
  return {
    core,
    desktop,
    combined: {
      weight,
      currentPoints,
      targetPoints,
      currentPercentage: percentage(currentPoints, weight),
      targetPercentage: percentage(targetPoints, weight),
    },
  }
}

export function validateClaudeParityEvidence(value: unknown): asserts value is ClaudeParityEvidenceV1 {
  rejectForbiddenData(value)
  const evidence = record(value, 'ClaudeParityEvidence')
  if (evidence.schemaVersion !== CLAUDE_PARITY_EVIDENCE_VERSION) throw new Error('Unknown Claude parity evidence version')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(evidence.snapshotDate, 'snapshotDate'))) throw new Error('Invalid snapshotDate')

  const targetIds = new Set(array(evidence.targets, 'targets').map((value, index) => {
    const target = record(value, `targets[${index}]`)
    const id = stableId(target.id, `targets[${index}].id`)
    text(target.boundary, `${id}.boundary`)
    text(target.source, `${id}.source`)
    return id
  }))
  if (!setEquals(targetIds, REQUIRED_TARGETS)) throw new Error('Claude parity targets must be distinct and complete')

  const scoring = record(evidence.scoring, 'scoring')
  if (JSON.stringify(scoring.values) !== JSON.stringify([0, 0.5, 1])
    || scoring.aheadCap !== 1 || scoring.excludedNonGoals !== true) {
    throw new Error('Invalid Claude parity scoring rubric')
  }

  const outcomes = array(evidence.outcomes, 'outcomes')
  const ids = new Set<string>()
  const acceptedDifferences = new Set<string>()
  for (const [index, value] of outcomes.entries()) {
    const outcome = record(value, `outcomes[${index}]`)
    const id = stableId(outcome.id, `outcomes[${index}].id`)
    if (ids.has(id)) throw new Error(`Duplicate Claude parity outcome: ${id}`)
    ids.add(id)
    if (outcome.lane !== 'core' && outcome.lane !== 'desktop') throw new Error(`Invalid lane for ${id}`)
    text(outcome.domain, `${id}.domain`)
    if (!Number.isInteger(outcome.weight) || (outcome.weight as number) <= 0) throw new Error(`Invalid weight for ${id}`)
    if (!SCORES.has(outcome.currentScore as ClaudeParityScore)
      || !SCORES.has(outcome.targetScore as ClaudeParityScore)) throw new Error(`Invalid score for ${id}`)
    assertOutcomeDisposition(outcome as unknown as ClaudeParityOutcomeV1)
    if (outcome.disposition === 'accepted-difference') acceptedDifferences.add(id)
    text(outcome.targetPhase, `${id}.targetPhase`)
    nonEmptyStrings(outcome.sourceRefs, `${id}.sourceRefs`)
    nonEmptyStrings(outcome.observables, `${id}.observables`)
  }
  if (!setEquals(acceptedDifferences, APPROVED_ACCEPTED_DIFFERENCES)) {
    throw new Error('Claude parity accepted differences must be explicit and complete')
  }

  const report = scoreClaudeParityEvidence({ outcomes: outcomes as unknown as ClaudeParityOutcomeV1[] })
  for (const lane of ['core', 'desktop'] as const) {
    if (report[lane].weight !== EXPECTED_LANE_WEIGHTS[lane]) throw new Error(`Invalid ${lane} denominator`)
  }
  if (report.combined.weight !== 100) throw new Error('Parity denominators overlap or are incomplete')
  if (JSON.stringify(report) !== JSON.stringify(evidence.expectedScore)) throw new Error('Claude parity expected score mismatch')

  nonEmptyStrings(evidence.exclusions, 'exclusions')
  const intake = record(evidence.runtimeIntake, 'runtimeIntake')
  text(intake.installedVersion, 'runtimeIntake.installedVersion')
  text(intake.candidateVersion, 'runtimeIntake.candidateVersion')
  text(intake.candidateGitHead, 'runtimeIntake.candidateGitHead')
  text(intake.candidateLicense, 'runtimeIntake.candidateLicense')
  text(intake.candidateNode, 'runtimeIntake.candidateNode')
  const packages = new Set(nonEmptyStrings(intake.packages, 'runtimeIntake.packages'))
  if (!setEquals(packages, REQUIRED_PI_PACKAGES)) throw new Error('Pi runtime intake must cover the exact eight-package family')
  const availability = record(intake.approvedRegistryAvailability, 'runtimeIntake.approvedRegistryAvailability')
  for (const name of REQUIRED_PI_PACKAGES) {
    if (availability[name] !== 'available' && availability[name] !== 'not-available') {
      throw new Error(`Missing approved-registry result for ${name}`)
    }
  }
  if (intake.decision !== 'stay-installed' && intake.decision !== 'upgrade') throw new Error('Invalid Pi runtime intake decision')
  text(intake.reason, 'runtimeIntake.reason')
}

export function validateClaudeDesktopEvidenceIndex(value: unknown): asserts value is ClaudeDesktopEvidenceIndexV1 {
  rejectForbiddenData(value)
  const index = record(value, 'ClaudeDesktopEvidenceIndex')
  if (index.schemaVersion !== 1) throw new Error('Unknown Claude Desktop evidence version')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(index.snapshotDate, 'snapshotDate'))) throw new Error('Invalid snapshotDate')
  const targets = new Set(array(index.targets, 'targets').map((value, offset) => {
    const target = record(value, `targets[${offset}]`)
    const id = stableId(target.id, `targets[${offset}].id`)
    text(target.source, `${id}.source`)
    return id
  }))
  if (!setEquals(targets, REQUIRED_DESKTOP_TARGETS)) throw new Error('Desktop evidence targets must be distinct and complete')
  const ids = new Set<string>()
  const outcomeIds = new Set<string>()
  for (const [offset, value] of array(index.cases, 'cases').entries()) {
    const entry = record(value, `cases[${offset}]`)
    const id = stableId(entry.id, `cases[${offset}].id`)
    if (ids.has(id)) throw new Error(`Duplicate Desktop evidence case: ${id}`)
    ids.add(id)
    if (!targets.has(text(entry.targetId, `${id}.targetId`))) throw new Error(`Unknown Desktop evidence target for ${id}`)
    const outcomeId = stableId(entry.outcomeId, `${id}.outcomeId`)
    if (outcomeIds.has(outcomeId)) throw new Error(`Duplicate Desktop evidence outcome: ${outcomeId}`)
    outcomeIds.add(outcomeId)
    if (!['implemented', 'partial', 'missing', 'accepted-difference'].includes(String(entry.status))) {
      throw new Error(`Invalid Desktop evidence status for ${id}`)
    }
    nonEmptyStrings(entry.evidenceRefs, `${id}.evidenceRefs`)
    const liveSmoke = record(entry.liveSmoke, `${id}.liveSmoke`)
    if (liveSmoke.status !== 'pending' && liveSmoke.status !== 'passed') {
      throw new Error(`Invalid Desktop live-smoke status for ${id}`)
    }
    text(liveSmoke.scenario, `${id}.liveSmoke.scenario`)
    const smokeEvidence = strings(liveSmoke.evidenceRefs, `${id}.liveSmoke.evidenceRefs`)
    if (liveSmoke.status === 'passed' && smokeEvidence.length === 0) {
      throw new Error(`Passed Desktop live smoke requires evidence for ${id}`)
    }
  }
  if (ids.size === 0) throw new Error('Desktop evidence cases are required')
}

/**
 * P13 close-out assertion. Structural evidence may remain valid while live
 * qualification is pending, but it cannot be reported as release-ready until
 * every required Desktop outcome has an implemented case and an executed smoke.
 */
export function assertClaudeParityCloseoutReady(
  core: ClaudeParityEvidenceV1,
  desktop: ClaudeDesktopEvidenceIndexV1,
): void {
  validateClaudeParityEvidence(core)
  validateClaudeDesktopEvidenceIndex(desktop)

  const report = scoreClaudeParityEvidence(core)
  for (const lane of ['core', 'desktop', 'combined'] as const) {
    if (report[lane].currentPercentage < MINIMUM_CLOSEOUT_PERCENTAGES[lane]) {
      throw new Error(`Claude parity ${lane} score is below the P13 close-out threshold`)
    }
  }

  const outcomes = new Map(core.outcomes.map(outcome => [outcome.id, outcome]))
  const cases = new Map(desktop.cases.map(entry => [entry.outcomeId, entry]))
  for (const outcome of core.outcomes) {
    if (outcome.lane !== 'desktop' || outcome.disposition !== 'required') continue
    const entry = cases.get(outcome.id)
    if (!entry) throw new Error(`Missing Desktop evidence case for required outcome: ${outcome.id}`)
    if (entry.status !== 'implemented') {
      throw new Error(`Required Desktop evidence case is not implemented: ${entry.id}`)
    }
  }

  for (const entry of desktop.cases) {
    const outcome = outcomes.get(entry.outcomeId)
    if (!outcome || outcome.lane !== 'desktop') {
      throw new Error(`Desktop evidence references an unknown Desktop outcome: ${entry.outcomeId}`)
    }
    if (entry.liveSmoke.status !== 'passed') {
      throw new Error(`Desktop live smoke is pending: ${entry.id}`)
    }
  }
}

function assertOutcomeDisposition(outcome: ClaudeParityOutcomeV1): void {
  if (!SCORES.has(outcome.currentScore) || !SCORES.has(outcome.targetScore)) {
    throw new Error(`Invalid score for ${outcome.id}`)
  }
  if (outcome.disposition === 'required') {
    if (APPROVED_ACCEPTED_DIFFERENCES.has(outcome.id)) {
      throw new Error(`Approved accepted difference must remain explicit: ${outcome.id}`)
    }
    if (outcome.currentScore !== 1 || outcome.targetScore !== 1) {
      throw new Error(`Required Claude parity outcome must score 1: ${outcome.id}`)
    }
    return
  }
  if (outcome.disposition !== 'accepted-difference') {
    throw new Error(`Invalid Claude parity disposition for ${outcome.id}`)
  }
  if (!APPROVED_ACCEPTED_DIFFERENCES.has(outcome.id)) {
    throw new Error(`Unapproved Claude parity accepted difference: ${outcome.id}`)
  }
  if (outcome.currentScore !== outcome.targetScore || outcome.currentScore === 1) {
    throw new Error(`Accepted difference must retain an uncompensated score: ${outcome.id}`)
  }
  text(outcome.acceptanceReason, `${outcome.id}.acceptanceReason`)
}

function rejectForbiddenData(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(rejectForbiddenData)
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key.replace(/[^a-z]/gi, '').toLowerCase())) throw new Error(`Forbidden evidence field: ${key}`)
    rejectForbiddenData(item)
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`)
  return value
}

function stableId(value: unknown, name: string): string {
  const id = text(value, name)
  if (!STABLE_ID.test(id)) throw new Error(`${name} must be a stable kebab-case ID`)
  return id
}

function nonEmptyStrings(value: unknown, name: string): string[] {
  const values = strings(value, name)
  if (values.length === 0) throw new Error(`${name} must not be empty`)
  return values
}

function strings(value: unknown, name: string): string[] {
  return array(value, name).map((item, index) => text(item, `${name}[${index}]`))
}

function setEquals<T>(left: Set<T>, right: Set<T>): boolean {
  return left.size === right.size && [...left].every(value => right.has(value))
}

function percentage(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 10_000) / 100
}
