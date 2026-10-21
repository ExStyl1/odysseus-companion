/**
 * P6.249 / denominator B33 — the TRIPWIRE the measure's own outcome rule owes.
 *
 * The measure asked one question: *can any user path put a sideload flag into a
 * child's argv, or is the surface genuinely absent?* It stated the outcome rule
 * in advance — *"none found → record `n/a` ×3 plus a TRIPWIRE test that fails if
 * such a producer appears"*. None was found, so this is that test.
 *
 * ## What was measured, 2026-09-07, and what it found that the row did not say
 *
 * The row's evidence is an ABSENCE: `--plugin-dir`, `--mcp-config` and
 * `--agents` score zero in the CLI's argument parser, and `disableSideloadFlags`
 * — `managed-settings.md`'s key for refusing them — scores zero in first-party
 * code (control `disableCommandPluginSources`: 51 hits).
 *
 * HALF of that is now REFUTED, by this file, on 2026-09-11: `--agents` exists
 * (`b0b4ed0b0`, P6.317 clause C) and the tripwire fired on it. See the note on
 * `SIDELOAD_FLAGS` below for why the property this file is named after still
 * holds. The `disableSideloadFlags` half stands and is a separate question —
 * an operator has no key for refusing the flag we now ship — recorded for the
 * plan rather than answered here.
 *
 * But an absence of three strings is a weak guarantee: it says nobody wrote
 * those flags, not that nobody CAN. The real guarantee is structural and it is
 * stronger than the row claims. `parseArgs` treats **every** unrecognized
 * dash-leading token as an error rather than absorbing it, gated by a
 * three-name allowlist (`PASSTHROUGH_SUBCOMMAND_FLAGS`), and `main()` reports
 * and exits on it *"before anything is spawned or connected"*. So the answer is
 * not "we happen not to pass these three" but "an unknown flag never reaches a
 * child at all, whatever it is named". That is what this file pins, because it
 * is the property that keeps holding when someone invents a fourth flag name.
 *
 * ## Why the test drives the parser instead of grepping for the names
 *
 * A grep for three literals goes green the moment a fourth sideload flag is
 * invented under a different name. Driving `parseArgs` fails for any of them,
 * and the positive control below is what proves the instrument can tell the two
 * cases apart — an absence finding needs a positive control on the same rig.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { parseAgentsArg, parseArgs, main } from './index.ts'

/**
 * D1.107 — the managed refusal's own seam, snapshotted BEFORE anything is
 * stubbed.
 *
 * AGENTS.md §Traps: a `mock.module` without a SPREAD amputates every other
 * export of that module for some other file in the batch, and a restore taken
 * from the LIVE namespace hands the mock back forever, because `mock.module`
 * mutates the namespace object in place. So the real namespace is captured here,
 * the stub spreads it, and the restore comes from this snapshot.
 */
const MANAGED_RESOLUTION = '@nessy-agent/server-core/bootstrap/managed-policy-resolution'
const realManagedResolution = { ...(await import(MANAGED_RESOLUTION)) }

function parse(...argv: string[]) {
  return parseArgs(['bun', 'nessy-general-agent', ...argv])
}

/**
 * THE TRIPWIRE FIRED, 2026-09-11, and this is what it found.
 *
 * `--agents` was one of the three the measure named, and it is no longer
 * unknown to the parser: `b0b4ed0b0` (P6.317 clause C) added it deliberately,
 * from `sub-agents.md#choose-the-subagent-scope`, which gives the flag priority
 * 2 — above `.claude/agents/`, `~/.claude/agents/` and plugin `agents/`, below
 * managed settings only.
 *
 * So the row's ABSENCE finding is refuted for that one name, and the test is
 * not simply relaxed to match. Read against what the tripwire is actually
 * about — *can any user path put a sideload flag into a CHILD's argv* — the
 * property still holds, and the case below pins the three reasons why rather
 * than deleting the name:
 *
 *   1. The value is inline JSON, not a PATH. `parseAgentsArg` refuses anything
 *      that is not an object of objects, so `--agents /tmp/evil` fails before
 *      the run starts; there is nothing to read off disk.
 *   2. It is written nowhere. The definitions travel on the `sessions:create`
 *      DTO (`opts.agents`) and are registered for that session only.
 *   3. It reaches no child argv. The CLI is an RPC client here; the flag is
 *      consumed in `main()` and in the two session-creating verbs.
 *
 * The other four spellings stay as they were: a path-taking sideload flag, by
 * any name, is still refused rather than absorbed.
 */
const SIDELOAD_FLAGS = [
  '--plugin-dir',
  '--mcp-config',
  '--plugin-root',
  '--agent-file',
] as const

describe('P6.249 · no user path puts a sideload flag into a child argv', () => {
  it('every sideload spelling is refused, not absorbed', () => {
    for (const flag of SIDELOAD_FLAGS) {
      const args = parse('run', flag, '/tmp/evil', 'hello')
      expect({ flag, unknown: args.unknownFlags }).toEqual({ flag, unknown: [flag] })
      // And its VALUE must not have become a prompt word either: a flag that
      // lands in `rest` for `run` is concatenated into the prompt, which is the
      // regression the unknown-flag gate was added for.
      expect({ flag, rest: args.rest }).toEqual({ flag, rest: ['/tmp/evil', 'hello'] })
    }
  })

  it('--agents is recognised now, and takes JSON rather than a path', () => {
    // The name the tripwire fired on. It is a flag, so it does not land in
    // `rest` and cannot become a prompt word — which is the regression the
    // unknown-flag gate exists for, reached by the other road.
    const args = parse('run', '--agents', '{"auditor":{"prompt":"Audit."}}', 'hello')
    expect(args.unknownFlags).toEqual([])
    expect(args.rest).toEqual(['hello'])
    expect(args.agents).toBe('{"auditor":{"prompt":"Audit."}}')

    // And the half that keeps it out of this file's subject: a PATH is refused
    // before the run starts, so the flag cannot be used to read a file.
    expect(() => parseAgentsArg('/tmp/evil')).toThrow(/^--agents is not valid JSON/)
    // The boundary on the same instrument, so the line above is not "throws at
    // everything": the documented shape is accepted.
    expect(parseAgentsArg('{"auditor":{"prompt":"Audit."}}')).toEqual({ auditor: { prompt: 'Audit.' } })
  })

  it('POSITIVE CONTROL: a real sub-flag is passed through by the same instrument', () => {
    // Without this the test above would pass on a parser that rejected
    // everything, which would prove nothing about sideloading.
    const args = parse('plugin', 'validate', './my-plugin', '--strict')
    expect(args.unknownFlags).toEqual([])
    expect(args.rest).toContain('--strict')
  })

  it('the allowlist that decides it is exactly these names, and no others', () => {
    // `PASSTHROUGH_SUBCOMMAND_FLAGS` is module-private, so it is probed through
    // the behaviour it controls rather than imported: these reach their
    // subcommand and NOTHING else dash-leading does. Adding one must be a
    // decision, not a diff.
    //
    // `--worktree` joined in P6.335 and this case did not notice, because it
    // only ever asserted that the names it LISTED were allowed — a guard that
    // cannot see a new entry is not doing the job its own comment claims. The
    // near-miss list is now derived from the allowed list rather than written
    // out beside it, so the two can no longer fall out of step.
    const allowlist = ['--stdin', '--name', '--strict', '--worktree'] as const
    for (const allowed of allowlist) {
      expect({ allowed, unknown: parse('session', 'create', allowed).unknownFlags })
        .toEqual({ allowed, unknown: [] })
    }
    // A near-miss on each, so the check is about the exact names.
    for (const allowed of allowlist) {
      const nearMiss = `${allowed}-not-this-one`
      expect({ nearMiss, unknown: parse('session', 'create', nearMiss).unknownFlags })
        .toEqual({ nearMiss, unknown: [nearMiss] })
    }
    // The direction the list alone cannot see: a name NOT in the allowlist is
    // rejected by the same instrument, so this is not "everything passes".
    expect(parse('session', 'create', '--plugin-dir').unknownFlags).toEqual(['--plugin-dir'])
  })

  it('an explicit positional escape still works, so the gate costs nothing legitimate', () => {
    // The parser's own documented remedy: "Use `--` before a positional
    // argument that starts with a dash."
    const args = parse('run', '--', '--plugin-dir')
    expect(args.unknownFlags).toEqual([])
  })
})
/**
 * D1.107 — the administrator's refusal, driven through `main()`.
 *
 * `settings-reference.md#disablesideloadflags`, verbatim: "Reject the
 * `--plugin-dir`, `--plugin-url`, `--agents`, and `--mcp-config` CLI flags at
 * startup, which users could otherwise pass to bypass `strictKnownMarketplaces`
 * for a single run. Claude Code exits with an error naming the rejected flags".
 * Scope `Managed`, Type Boolean, Default `false`.
 *
 * The file above pins that three of those four names never reach a child. This
 * block pins the fourth, which we DO ship and which an operator had no key for.
 *
 * `doctor` is the command in both arms for one reason: the gate runs for it
 * (it is neither `help` nor `version`), and it spawns no server, so the control
 * arm can let `main()` run to completion without starting anything.
 */
describe('D1.107 · disableSideloadFlags refuses --agents at startup', () => {
  afterEach(() => {
    mock.module(MANAGED_RESOLUTION, () => realManagedResolution)
  })

  async function driveDoctorWithAgents(policy: Record<string, unknown>): Promise<{
    stderr: string
    exits: number[]
  }> {
    mock.module(MANAGED_RESOLUTION, () => ({
      ...realManagedResolution,
      resolveEnforcedManagedPolicy: () => ({ policy, drops: [] }),
    }))

    const exits: number[] = []
    const originalExit = process.exit
    // THROWS rather than records: `main()` continues past a no-op stub, and the
    // refusal's whole promise is that nothing happens after it.
    const sentinel = new Error('process.exit')
    process.exit = ((code?: number | string | null) => {
      exits.push(Number(code ?? 0))
      throw sentinel
    }) as typeof process.exit
    const originalStderr = process.stderr.write.bind(process.stderr)
    const originalStdout = process.stdout.write.bind(process.stdout)
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true }) as typeof process.stderr.write
    process.stdout.write = (() => true) as typeof process.stdout.write

    try {
      await main(['bun', 'nessy-general-agent', '--agents', '{"auditor":{"prompt":"Audit."}}', 'doctor'])
    } catch (e) {
      if (e !== sentinel) throw e
    } finally {
      process.exit = originalExit
      process.stderr.write = originalStderr
      process.stdout.write = originalStdout
    }
    return { stderr, exits }
  }

  it('refuses, NAMES the flag, and exits non-zero', async () => {
    const { stderr, exits } = await driveDoctorWithAgents({ disableSideloadFlags: true })
    // "exits with an error naming the rejected flags" — the name is the half a
    // user can act on, so it is asserted rather than the message's wording.
    expect(stderr).toContain('--agents')
    expect(stderr).toContain('disableSideloadFlags')
    expect(exits).toEqual([1])
  })

  it('the control: the documented default accepts the flag, so nothing moves by default', async () => {
    // Non-vacuity in the direction that matters most here. `false` is the page's
    // own default, and an absent key must behave the same way — a refusal that
    // fired without the key would break every operator who never set it.
    const { stderr, exits } = await driveDoctorWithAgents({})
    expect(stderr).not.toContain('disableSideloadFlags')
    expect(exits).toEqual([])
  })

  it('the boundary: an explicit false is still an accept', async () => {
    const { stderr, exits } = await driveDoctorWithAgents({ disableSideloadFlags: false })
    expect(stderr).not.toContain('disableSideloadFlags')
    expect(exits).toEqual([])
  })
})
