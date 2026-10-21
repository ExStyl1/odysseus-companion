/**
 * F1.725 (WJ-crit-u, 2026-09-25) — an agent in `plan` mode can write its OWN plan
 * file and submit it, on Pi and on claude, on both config-dir layouts.
 *
 * ## The reading, taken first (release sitting SIT-i on Pi, SIT-f on claude-gateway)
 *
 * No plan could be submitted in `plan` mode. `permission-modes.md#analyze-before-you-edit-with-plan-mode`,
 * verbatim: *"Claude reads files, runs shell commands to explore, and writes a plan,
 * but does not edit your source."* Three layers each refused the plan file:
 *
 *  1. the mode gate (`shouldAllowToolInMode`, shared by claude's PreToolUse hook and
 *     Pi's `pre_tool_use` bridge) opened the plans folder in `explore` only — a
 *     `plan`-mode Write answered "File modifications are blocked in Plan", and
 *     SubmitPlan then answered "Plan file not found";
 *  2. the protected-path floor answered a non-negotiable card for the session's own
 *     plans folder in every mode that prompts — by the `.nessy-agent` segment on the
 *     default layout, and by F1.677's data-folder location on a relocated one — so
 *     `explore` (the one mode the gate opened) raised "This writes to the protected
 *     directory";
 *  3. Pi's file tool refused the path after any card, in every mode:
 *     "Managed Nessy storage is not accessible to file tools" — the session folder is
 *     under the managed exclusion, and the managed allowances named only `docs`, the
 *     workspace's `sources/` and `skills`.
 *
 * SIT-d found the sibling on the same scope: Pi's Read refused the session's OWN
 * attachment (`<session>/attachments/…`), whose path is all the prompt carries.
 *
 * ## The fix (DECIDED, transparent and simple)
 *
 *  - the gate: `plan` opens the plans folder to Write/Edit/MultiEdit of a `.md`
 *    file — the plan — and nothing else (`explore`'s wider exception is unchanged);
 *  - the floor: the session's OWN plans folder under the data folder is not a
 *    protected path, as written and by real path (claude + Pi);
 *  - Pi's scope: the session's own `plans/` is writable and its own `attachments/`
 *    readable; another session's folders, and the rest of the data folder, stay
 *    refused.
 *
 * ## F1.762 (DN-245, 2026-09-28) — explore's data-folder exception, the same three layers
 *
 * The mode gate admits `<session>/data` in `explore` too. Read at HEAD 2f7c1deb9 on both
 * layouts: layers 1 and 2 already let the four write tools through with no card (F1.703's
 * own-folder carve-out, 8cc5128c6), and layer 3 refused — Pi's Write of `data/findings.md`
 * answered "Managed Nessy storage is not accessible to file tools" and nothing landed.
 * F1.1046 (2b9c72470) opened the session's own folder to Pi's file tools minus its records
 * (`session.jsonl`, `attachments/` write, `long_responses/`), so the write now lands.
 *
 * Driven in a CHILD per layout so each gets its own frozen `CONFIG_DIR`
 * (`fixtures/session-plan-file-probe.ts`).
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Two children, each loading the gate's module graph cold.
setDefaultTimeout(240_000)

const PROBE = join(import.meta.dir, 'fixtures', 'session-plan-file-probe.ts')
const SCRATCH = mkdtempSync(join(tmpdir(), 'f1725-layouts-'))
afterAll(() => { rmSync(SCRATCH, { recursive: true, force: true }) })

interface ProbeOut {
  configDir: string
  plans: string
  gate: Record<string, string>
  tool: Record<string, { isError: boolean; content: string }>
  planFileWritten: string | null
  otherPlanWritten: boolean
  submit: { isError: boolean; text: string; submitted: string[] }
  dataFileWritten: string | null
  otherDataWritten: boolean
}

async function probe(layout: 'relocated' | 'default'): Promise<ProbeOut> {
  const home = join(SCRATCH, layout, 'home')
  mkdirSync(home, { recursive: true })
  const configDir = layout === 'default' ? join(home, '.nessy-agent') : join(SCRATCH, layout, 'nessy-data')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  env.HOME = home
  env.NESSY_CONFIG_DIR = configDir
  const child = Bun.spawn(['bun', PROBE], { env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`probe (${layout}) exited ${code}: ${stderr.slice(-2000)}`)
  const out = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as ProbeOut
  // Provenance before any verdict: the child's data folder is this scratch one, never the real one.
  expect(out.configDir).toBe(configDir)
  return out
}

for (const layout of ['relocated', 'default'] as const) {
  describe(`F1.725 — the session's own plan file, ${layout} data folder`, () => {
    let out: ProbeOut
    it('probe ran against the scratch data folder', async () => {
      out = await probe(layout)
      expect(out.plans.startsWith(out.configDir)).toBe(true)
    })

    it('gate (claude PreToolUse + Pi pre_tool_use): plan mode writes and edits its own .md plan with no card', () => {
      expect(out.gate['plan Write own plan .md']).toBe('allow')
      expect(out.gate['plan Edit own plan .md']).toBe('allow')
      expect(out.gate['plan Write own plan via ..']).toBe('allow')
    })

    // F1.1050 (DN-272) deleted "gate: explore writes its own plan with no protected-path card" with the retired
    // mode; plan's own .md plan arms above run through the same floor.

    it('gate controls: plan mode still refuses source, non-plan files, escapes, another session and the data folder', () => {
      expect(out.gate['plan Write project source']).toMatch(/^block:File modifications are blocked in Plan/)
      expect(out.gate['plan Write own plans folder non-md']).toMatch(/^block:File modifications are blocked in Plan/)
      expect(out.gate['plan Write escape via ..']).toMatch(/^block:/)
      expect(out.gate["plan Write another session's plan"]).toMatch(/^block:/)
      expect(out.gate['plan Write data-folder skill']).toMatch(/^block:/)
      expect(out.gate['dontAsk Write own plan .md']).not.toBe('allow')
    })

    it("Pi's file tool writes the plan the gate admitted; another session's folder and the data folder stay refused", () => {
      expect(out.tool['write own plan']?.isError).toBe(false)
      expect(out.planFileWritten).toContain('# Plan: add subtract')
      expect(out.tool['write another session plan']?.isError).toBe(true)
      expect(out.tool['write another session plan']?.content).toContain('Managed Nessy storage is not accessible')
      expect(out.otherPlanWritten).toBe(false)
      expect(out.tool['write data-folder hooks.json']?.isError).toBe(true)
    })

    it("SubmitPlan finds the written plan and hands it to the plan-mode port (the plan card)", () => {
      expect(out.submit.isError).toBe(false)
      expect(out.submit.submitted).toEqual([join(out.plans, 'add-subtract.md')])
    })

    it("SIT-d: Pi's Read opens the session's own attachment; writing there and another session's attachment stay refused", () => {
      expect(out.tool['read own attachment']?.isError).toBe(false)
      expect(out.tool['read own attachment']?.content).toContain('attached text')
      expect(out.tool['write own attachment']?.isError).toBe(true)
      expect(out.tool['read another session attachment']?.isError).toBe(true)
      expect(out.tool['read another session attachment']?.content).toContain('Managed Nessy storage is not accessible')
    })

    it("F1.762 + F1.1050: plan writes the session's own data folder through every layer — the gate (claude and Pi) and Pi's file tool", () => {
      expect(out.gate['plan Write own data']).toBe('allow')
      expect(out.gate['plan Edit own data']).toBe('allow')
      expect(out.gate['plan MultiEdit own data']).toBe('allow')
      expect(out.gate['plan NotebookEdit own data']).toBe('allow')
      expect(out.tool['write own data']?.isError).toBe(false)
      expect(out.dataFileWritten).toContain('subtract is missing')
      expect(out.tool['read own data']?.isError).toBe(false)
      expect(out.tool['read own data']?.content).toContain('subtract is missing')
    })

    // F1.1050 (DN-272) flipped this arm: it pinned "plan Write own data → block" while explore held the data
    // folder alone. Plan now absorbs the retired explore's data-folder write, so the same Write is allowed; the
    // records, another session's data and project source (above) stay refused in plan.
    it('F1.1050: plan mode writes the session data folder as explore did; the records and another session stay refused', () => {
      expect(out.gate['plan Write own data']).toBe('allow')
      expect(out.gate['plan Edit own data']).toBe('allow')
      expect(out.gate['plan NotebookEdit own data']).toBe('allow')
      expect(out.gate['plan Write own session.jsonl']).not.toBe('allow')
      expect(out.gate["plan Write another session's data"]).not.toBe('allow')
      expect(out.tool['write another session data']?.isError).toBe(true)
      expect(out.tool['write another session data']?.content).toContain('Managed Nessy storage is not accessible')
      expect(out.otherDataWritten).toBe(false)
      expect(out.tool['write own session.jsonl']?.isError).toBe(true)
      expect(out.tool['write own long_responses']?.isError).toBe(true)
    })
  })
}
