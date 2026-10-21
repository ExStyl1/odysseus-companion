/**
 * C3.276 — the two rosters disagree, and both halves of saying so are pinned.
 *
 * C3.183 drove it (2026-09-11): a flat `<project>/.claude/commands/<name>.md`
 * with no frontmatter is named in the CLAUDE child's own `system/init`
 * `slash_commands` and its body reaches the upstream turn, against a control
 * with no file that has neither. This host's loader reads two other directories
 * and never that one, on any runtime — so on a claude session the runtime
 * dispatches a list the composer never showed, and on the other two the file is
 * not a command at all.
 *
 * The decision is to SURFACE rather than close: a third `COMMAND_DIRS` entry
 * would register the same name twice on claude (expanded by this host and
 * dispatched by the child, with no rule saying which body wins) and would bypass
 * the setup import, which exists to copy those files in under the user's own
 * eye. That is a product posture and it is the owner's, not a lane's.
 *
 * What this file guards is the pair: the loader's behaviour, and that the
 * surface which tells the user about it still exists. `COMMAND_DIRS` is not
 * exported, so the loader half is asserted BEHAVIOURALLY, against a real
 * temporary tree — the strongest available instrument and the one a rename
 * cannot fool.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { listCustomSlashCommands } from '../custom-commands.ts'

const root = mkdtempSync(join(tmpdir(), 'nessy-c3276-'))
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function writeCommand(relativeDir: string, name: string, body: string): void {
  const dir = join(root, relativeDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), body, 'utf8')
}

const repoFile = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url)), 'utf8')

describe('the host command loader and the claude child read different directories', () => {
  writeCommand('.nessy-agent/commands', 'hostowned', 'the host roster')
  writeCommand('.agents/commands', 'agentsowned', 'the second host root')
  writeCommand('.claude/commands', 'claudeowned', 'dispatched by the child, listed by nobody')

  const names = listCustomSlashCommands({ workspaceRootPath: root }).map(command => command.name)

  it('lists both host roots — the positive control that makes the absence below a measurement', () => {
    // Without these two, a loader that had stopped finding anything at all would
    // satisfy the assertion that follows.
    expect(names).toContain('hostowned')
    expect(names).toContain('agentsowned')
  })

  it('does NOT list a project `.claude/commands` file, on any runtime', () => {
    // The loader is runtime-agnostic: one list serves Pi, claude and codex, so
    // this single absence is the absence on all three.
    expect(names).not.toContain('claudeowned')
  })

  it('keeps the surface that tells the user, so the difference is disclosed and not merely true', () => {
    // The pair AGENTS.md §Traps asks for: the constant asserts what the cost row
    // says, and this is the only place the two are read together. A third
    // COMMAND_DIRS entry without moving the row would land here.
    const costs = repoFile('apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts')
    expect(costs).toContain("id: 'claudeProjectCommands'")
    expect(costs).toContain("bodyKey: 'chat.runtimeSwitch.costClaudeProjectCommands'")
    const gaps = repoFile('docs/architecture/runtime-capability-gaps.md')
    // Once in the Pi section and once in the Codex section — the row fires into
    // both, and a single occurrence would mean one of them lost its disclosure.
    expect(gaps.split('`.claude/commands` file is not a command here').length - 1).toBe(2)
  })
})
