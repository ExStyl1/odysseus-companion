/**
 * D1.251 — the session's own storage directory reaches a surface, and says the
 * true thing about the session it is on.
 *
 * ## The premise, re-measured at HEAD before this landed
 *
 * WI-q measured `sdkCwd` at **0** occurrences over `protocol` + `renderer` +
 * `electron/shared` and concluded, correctly, that posture B needed a wire field
 * first. What the census could not see is that the VALUE was already crossing:
 * `sdkCwd` is in `SESSION_PERSISTENT_FIELDS` and `managedToSession` builds every
 * Session DTO by spreading `pickSessionFields(m)` — the same route
 * `workingDirectory`, `model` and `llmConnection` take, none of which that
 * function names either. What was missing was the DECLARATION, which is why no
 * `SessionManager` fill was owed and no hand-off was made.
 *
 * The chain below is therefore four links, and the two that can be exercised for
 * real are: `SESSION_PERSISTENT_FIELDS` carries the field, and `pickSessionFields`
 * keeps it. The two projections are pinned by source, for the reason every
 * renderer suite here pins one.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { SESSION_PERSISTENT_FIELDS, pickSessionFields } from '@nessy-agent/shared/sessions'
import { sessionStorageWorkingDirectory } from '../session-storage-notice'

describe('sessionStorageWorkingDirectory', () => {
  it('names the storage directory for a session with no project folder', () => {
    expect(sessionStorageWorkingDirectory({ sdkCwd: '/store/sessions/s-1' })).toBe('/store/sessions/s-1')
  })

  it('says NOTHING for a session that has a project folder', () => {
    // The rule that is easy to get backwards: `sdkCwd` is EQUAL to the project
    // folder when there is one, so a rule keyed on its presence alone would put
    // the sentence on every session in the app, where it is false.
    expect(sessionStorageWorkingDirectory({ workingDirectory: '/work/app', sdkCwd: '/work/app' })).toBeNull()
  })

  it('says nothing when the directory is unknown or empty', () => {
    // An older server, or a record written before the field existed. A surface
    // that cannot name the directory says nothing rather than guessing one.
    expect(sessionStorageWorkingDirectory({})).toBeNull()
    expect(sessionStorageWorkingDirectory({ sdkCwd: '   ' })).toBeNull()
  })
})

describe('the field really crosses — the chain, link by link', () => {
  it('is persisted, and `pickSessionFields` keeps it (the two real links)', () => {
    expect(SESSION_PERSISTENT_FIELDS).toContain('sdkCwd')
    const picked = pickSessionFields({ id: 's-1', sdkCwd: '/store/sessions/s-1', name: 'x' })
    expect(picked.sdkCwd).toBe('/store/sessions/s-1')
    // The negative control on the same instrument: a field nobody persists is
    // dropped, so the positive above is the list's doing and not the spread's.
    expect('notAField' in pickSessionFields({ id: 's-1', notAField: 'y' })).toBe(false)
  })

  it('is declared on the Session DTO and on the renderer\'s SessionMeta', () => {
    const dto = readFileSync(
      fileURLToPath(new URL('../../../../../../packages/shared/src/protocol/dto.ts', import.meta.url)),
      'utf8',
    )
    expect(dto).toContain('sdkCwd?: string')
    const atoms = readFileSync(fileURLToPath(new URL('../../atoms/sessions.ts', import.meta.url)), 'utf8')
    expect(atoms).toContain('sdkCwd?: string')
    // `extractSessionMeta` spreads the whole session, which is why declaring the
    // field is all the renderer side needs.
    expect(atoms).toContain('...sessionFields')
  })

  it('the working-directory badge renders it, and only in the no-folder branch', () => {
    const input = readFileSync(
      fileURLToPath(new URL('../../components/app-shell/input/FreeFormInput.tsx', import.meta.url)),
      'utf8',
    )
    expect(input).toContain('sessionStorageWorkingDirectory({')
    expect(input).toContain("t(\"chat.sessionStorageWorkingDirectory\", { path: formatPathForDisplay(sessionStorageDirectory, homeDir) })")
    // The sentence sits in the `hasFolder ? … : …` else-branch: the badge's
    // no-folder state is the only place it is true.
    const at = input.indexOf('chat.sessionStorageWorkingDirectory')
    expect(input.lastIndexOf('hasFolder ? (', at)).toBeGreaterThan(-1)

    // The link with no other instrument: without the id the badge reads no
    // metadata and the sentence can never appear. UB14.31 moved the badge's
    // mount from ChatInputZone's footer row into FreeFormInput's toolbar.
    const mountAt = input.indexOf('<WorkingDirectoryBadge')
    expect(mountAt).toBeGreaterThan(-1)
    expect(input.slice(mountAt, input.indexOf('/>', mountAt))).toContain('sessionId={sessionId}')
  })

  it('the sentence names the path in both locales', () => {
    for (const locale of [en, ru] as Record<string, string>[]) {
      const line = locale['chat.sessionStorageWorkingDirectory'] ?? ''
      // The positive control: a missing key reads as an empty string and would
      // satisfy any `not.toContain` beside it while proving nothing.
      expect(line.length).toBeGreaterThan(0)
      expect(line).toContain('{{path}}')
    }
  })
})
