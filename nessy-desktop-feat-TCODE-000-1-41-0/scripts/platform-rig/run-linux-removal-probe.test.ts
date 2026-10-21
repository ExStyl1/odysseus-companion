/**
 * Invariants of the LINUX platform rig itself, checked without a container.
 *
 * The rig is a machine that runs `rm`, so what it must not do matters more than
 * what it does. These tests hold the two properties that make it safe and the
 * two that make it honest:
 *
 * - **Safe.** Every corpus command targets only `$HOME` or `~`, and every id and
 *   command reaches the container through single-quoting no payload can escape.
 *   A corpus entry naming an absolute path would run inside the container against
 *   a path the rig did not create.
 * - **Honest.** The controls the driver refuses to run without are actually in
 *   the corpus, and the ids are unique so the join cannot silently drop a row.
 *
 * The measurement itself needs a daemon and is not asserted here — running the
 * probe is `bun scripts/platform-rig/run-linux-removal-probe.ts`.
 */
import { describe, expect, test } from 'bun:test'
import { CONTROL_IDS, EMPTY_HOME_IDS, REMOVAL_CORPUS } from './removal-corpus.ts'
import { buildContainerScript, PROBE_ROOT, shQuote } from './run-linux-removal-probe.ts'

describe('platform rig — the corpus cannot name a path it did not create', () => {
  test('every command targets $HOME or ~ and nothing else', () => {
    expect(REMOVAL_CORPUS.length).toBeGreaterThan(10)
    for (const entry of REMOVAL_CORPUS) {
      expect(entry.command).toMatch(/(\$HOME|~)/)
      // No absolute operand. `/` appears legitimately inside `"$HOME"/*`, so the
      // check is for a word STARTING at the filesystem root, which is the shape
      // that would reach outside the synthetic tree.
      const words = entry.command.split(/\s+/)
      for (const word of words) {
        const bare = word.replace(/^["']|["']$/g, '')
        if (bare.startsWith('--') || bare.startsWith('-')) continue
        expect(bare.startsWith('/')).toBe(false)
      }
    }
  })

  test('ids are unique — the join is by id and a duplicate would hide a row', () => {
    const ids = REMOVAL_CORPUS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('every control the driver demands is present, and every empty-home id exists', () => {
    const ids = new Set(REMOVAL_CORPUS.map((entry) => entry.id))
    for (const id of CONTROL_IDS) expect(ids.has(id)).toBe(true)
    for (const id of EMPTY_HOME_IDS) expect(ids.has(id)).toBe(true)
  })
})

describe('platform rig — the container script', () => {
  test('quotes a payload containing a single quote so it cannot break out', () => {
    // The failure this guards: a corpus entry such as `rm -rf "$HOME"/'a b'`
    // would, under naive quoting, close the shell string and let the rest of the
    // entry run as script rather than as an operand.
    const quoted = shQuote(`a'b`)
    const script = `id=${quoted}; printf '%s' "$id"`
    const result = Bun.spawnSync(['sh', '-c', script])
    expect(result.stdout.toString()).toBe(`a'b`)
  })

  test('emits exactly one run_one line per corpus entry', () => {
    const script = buildContainerScript()
    const runs = script.split('\n').filter((line) => line.startsWith('run_one '))
    expect(runs).toHaveLength(REMOVAL_CORPUS.length)
    // The empty-home flag is positional; a shifted argument would silently build
    // every tree empty and score every row `intact`.
    for (const entry of REMOVAL_CORPUS) {
      const expected = `run_one ${shQuote(entry.id)} ${EMPTY_HOME_IDS.has(entry.id) ? '1' : '0'} `
      expect(runs.some((line) => line.startsWith(expected))).toBe(true)
    }
  })

  test('every path the script writes is under the container-only probe root', () => {
    const script = buildContainerScript()
    expect(PROBE_ROOT.startsWith('/')).toBe(true)
    expect(script).toContain(`PROBE=${PROBE_ROOT}`)
    // `mkdir` and the cleanup `rm` both resolve through "$root", which is
    // "$PROBE/$id". If either ever stops doing so, the rig can write outside the
    // directory it owns even inside the container.
    expect(script).toContain('root="$PROBE/$id"; home="$root/home"')
    expect(script).toContain('rm -rf "$root" 2>/dev/null')
  })

  test('the corpus reaches the container by stdin, never by a host mount', async () => {
    // Read as source text on purpose: the guarantee is about which docker flags
    // exist, and no sampled run can prove a flag is absent.
    const body = await Bun.file(new URL('./run-linux-removal-probe.ts', import.meta.url)).text()
    // The `docker run` argument array ONLY, located by an anchor the mutation
    // this guards cannot remove. Two earlier spellings both let a mutant that
    // deletes `--network none` survive, and each failed differently:
    //   1. slicing from `'run', '--rm', '-i', '--network'` — the anchor died
    //      with the flag, `indexOf` returned -1, `slice(-1)` gave one character
    //      and `toContain` passed on a string holding nothing;
    //   2. asserting on the WHOLE file — the module makes a SECOND `docker run`
    //      (the `rm --version` banner) which carries the flag independently.
    // So: anchor on the part the mutant keeps, and bound the slice at the
    // array's own closing bracket.
    const runStart = body.indexOf("['run', '--rm', '-i'")
    expect(runStart).toBeGreaterThan(-1)
    const runArray = body.slice(runStart, body.indexOf(']', runStart) + 1)
    expect(runArray).toContain("'--network', 'none'")
    // `-v` is how a host path would get in. It must not appear in the driver.
    expect(runArray).not.toContain("'-v'")
    expect(body).not.toContain("'-v',")
  })
})
