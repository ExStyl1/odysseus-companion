/**
 * UA12.42 — the load-time repair of label ids minted before UA12.40. createLabel
 * used to give a label whose name has no Latin letters («Срочно») the id "" and
 * the next one "-2"; both fail isValidLabelIdFormat and the labels config schema,
 * so config_validate reports them and the PreToolUse config guard refuses every
 * agent Write/Edit of labels/config.json until they are fixed. repairLegacyLabelIds
 * renames such ids by the UA12.40 convention and relabels the sessions carrying
 * them in one pass.
 *
 * The workspace root is the real v2 layout (getWorkspaceRootPath under the
 * isolated test config dir), and sessions are seeded through the real storage
 * API — the UA12.41 statuses/crud.test.ts shape: updateSessionMetadata rewrites
 * the JSONL on disk, so listSessions reads back what the repair wrote.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, rmSync } from 'fs'

import { repairLegacyLabelIds, loadLabelConfig, saveLabelConfig } from '../storage.ts'
import { mapLabelEntryId } from '../values.ts'
import { createSession, listSessions } from '../../sessions/storage.ts'
import { getWorkspaceRootPath, getWorkspaceSessionRootPath } from '../../workspaces/paths.ts'
import { validateLabels } from '../../config/validators.ts'
import type { WorkspaceLabelConfig } from '../types.ts'

let workspaceRoot: string
let workspaceId: string

beforeEach(() => {
  workspaceId = `ua12-42-${randomUUID()}`
  workspaceRoot = getWorkspaceRootPath(workspaceId)
  mkdirSync(workspaceRoot, { recursive: true })
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
  rmSync(getWorkspaceSessionRootPath(workspaceId), { recursive: true, force: true })
})

const configWith = (labels: WorkspaceLabelConfig['labels']): WorkspaceLabelConfig => ({ version: 1, labels })

describe('repairLegacyLabelIds (UA12.42)', () => {
  it('renames a stored "" id to label, relabels the tagged session in one pass, and validateLabels turns valid', async () => {
    saveLabelConfig(workspaceRoot, configWith([{ id: '', name: 'Срочно', color: 'accent' }]))
    const session = await createSession(workspaceId, { name: 'Tagged', labels: [''] })

    // The defect the row cures: the stored id is what the config guard refuses.
    expect(validateLabels(workspaceRoot).valid).toBe(false)

    const repair = await repairLegacyLabelIds(workspaceRoot, workspaceId)

    expect(repair.renamed.get('')).toBe('label')
    expect(repair.relabeled).toBe(1)
    const loaded = loadLabelConfig(workspaceRoot)
    expect(loaded.labels[0]!.id).toBe('label')
    expect(loaded.labels[0]!.name).toBe('Срочно')
    const carried = listSessions(workspaceId).find(s => s.id === session.id)
    expect(carried?.labels).toEqual(['label'])
    expect(validateLabels(workspaceRoot).valid).toBe(true)
  })

  it('is a no-op for a healthy config: nothing renamed, no session pass, file bytes untouched', async () => {
    saveLabelConfig(workspaceRoot, configWith([{ id: 'bug', name: 'Bug', color: 'accent' }]))
    await createSession(workspaceId, { name: 'Untagged' })
    const before = readFileSync(`${workspaceRoot}/labels/config.json`, 'utf-8')

    const repair = await repairLegacyLabelIds(workspaceRoot, workspaceId)

    expect(repair.renamed.size).toBe(0)
    expect(repair.relabeled).toBe(0)
    expect(readFileSync(`${workspaceRoot}/labels/config.json`, 'utf-8')).toBe(before)
  })

  it('a taken target shifts through the suffix loop: "" beside a real label becomes label-2', async () => {
    saveLabelConfig(workspaceRoot, configWith([
      { id: '', name: 'Срочно', color: 'accent' },
      { id: 'label', name: 'Label', color: 'accent' },
    ]))
    const session = await createSession(workspaceId, { labels: [''] })

    const repair = await repairLegacyLabelIds(workspaceRoot, workspaceId)

    expect(repair.renamed.get('')).toBe('label-2')
    const carried = listSessions(workspaceId).find(s => s.id === session.id)
    expect(carried?.labels).toEqual(['label-2'])
    expect(validateLabels(workspaceRoot).valid).toBe(true)
  })

  it('a minted -N id keeps its number as label-N, and valued session entries keep their raw value', async () => {
    saveLabelConfig(workspaceRoot, configWith([
      { id: '-2', name: 'Важно', color: 'accent', valueType: 'number' },
    ]))
    const session = await createSession(workspaceId, { labels: ['-2::03'] })

    const repair = await repairLegacyLabelIds(workspaceRoot, workspaceId)

    expect(repair.renamed.get('-2')).toBe('label-2')
    const carried = listSessions(workspaceId).find(s => s.id === session.id)
    expect(carried?.labels).toEqual(['label-2::03'])
    expect(validateLabels(workspaceRoot).valid).toBe(true)
  })
})

describe('mapLabelEntryId (UA12.42)', () => {
  const map = new Map([['', 'label'], ['-2', 'label-2']])

  it('remaps a boolean entry and a valued entry, byte-preserving the raw value', () => {
    expect(mapLabelEntryId('', map)).toBe('label')
    expect(mapLabelEntryId('-2::3', map)).toBe('label-2::3')
    expect(mapLabelEntryId('-2::03', map)).toBe('label-2::03')
  })

  it('leaves an entry whose id the map does not hold untouched', () => {
    expect(mapLabelEntryId('bug', map)).toBe('bug')
    expect(mapLabelEntryId('priority::3', map)).toBe('priority::3')
  })
})
