/**
 * Fixture tree for `SKL-P1` — a `paths:`-gated plugin skill that also carries a
 * comma-bearing `allowed-tools` entry.
 *
 * ```bash
 * bun run scripts/cdp/fixtures/paths-skill.ts          # build/refresh the tree
 * bun run scripts/cdp/fixtures/paths-skill.ts --print  # just say where it is
 * ```
 *
 * **This fixture exists because no public artifact does.** The independent live
 * audit of the signed 1.25.0 searched `anthropics/skills`, `anthropics/claude-code`,
 * `anthropics/claude-plugins-official`, `obra/superpowers`, `mattpocock/skills`
 * and `duckdb/duckdb-skills` and found **no `SKILL.md` anywhere declaring
 * `paths:`** — so the half of the 1.25.0 promise that says a plugin skill's
 * activation patterns survive installation has never been exercised against a
 * real install, and the documented gate has never been exercised at all.
 *
 * The contract, quoted from the raw page rather than a summary of it
 * (`https://code.claude.com/docs/en/skills.md`, the `paths` row of the
 * frontmatter table, fetched 2026-08-12 — quote the sentence, not the line
 * number, because the page grows):
 *
 * > `paths` … Glob patterns that limit when this skill is activated. Accepts a
 * > comma-separated string or a YAML list. When set, Claude loads the skill
 * > automatically only when working with files matching the patterns. Uses the
 * > same format as path-specific rules.
 *
 * "Automatically" is the whole gate: `base-agent.ts` checks it on the **model**
 * origin only (`pathGatedSkillIsInScope`, called at the `origin === 'model'`
 * branch of the skill-invocation admission), so a USER invoking the skill by
 * name is never gated. A case that drives the gated skill from the `/` menu and
 * reports a pass has measured nothing.
 *
 * ## What each piece exists to make observable
 *
 * | fixture | the behaviour it exposes |
 * | --- | --- |
 * | `cdp-paths-gated` skill with two `paths:` patterns | the 1.25.0 metadata promise (`paths` survives install) AND the documented activation gate |
 * | the same skill's `allowed-tools` block list whose third item is `Agent(cdp-paths-probe:alpha, cdp-paths-probe:beta)` | DEFECT-2's exact shape: one comma inside one parenthesized specifier used to abort the WHOLE list, so the field arrived `undefined` and the ceiling vanished silently |
 * | `cdp-paths-control` skill — same shape, NO `paths` | the positive control the gate half is worthless without: "the model did not invoke the gated skill" proves nothing until something on the same rig makes the model invoke a skill at all |
 * | `agents/alpha.md` + `agents/beta.md`, one of them declaring the same parenthesized grant in `tools:` | the grant names real components, and the agent-frontmatter half of the same tokenizer (`splitToolGrantList`) rides along |
 * | `project/schema.sql` (matches) + `project/notes.txt` (does not) | the file read that RECORDS an activation, and its negative control, each carrying its own per-run marker |
 *
 * **`Agent(a, b)` is also the shape that made every Pi turn fail** on the signed
 * 1.25.0 once the official `claude-security` plugin was installed (the audit's
 * DEFECT-3: parametrized grants never resolve against the Pi manifest and the
 * residual `unresolved` list was thrown, aborting the turn rather than denying
 * the tool). This tree is therefore also the regression fixture for that fix —
 * on a pre-fix build the very first Pi turn dies with
 * `Unavailable runtime agent tool(s): Agent(cdp-paths-probe:alpha, …)`, and that
 * is the pre-fix expectation, not a broken fixture.
 *
 * Everything lands under one root (`NESSY_CDP_SKP_ROOT`, default
 * `~/nessy-cdp-skp`) including the app's `NESSY_CONFIG_DIR`, so the whole
 * fixture is `rm -rf`-able and the operator's own `~/.nessy-agent` is never
 * touched. Nothing here reads or writes `~/.nessy/dp_auth_creds.json`: that file
 * is nessy-cli's contract and only the APP may read it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function fixtureRoot(): string {
  return process.env.NESSY_CDP_SKP_ROOT ?? join(homedir(), 'nessy-cdp-skp')
}

export interface FixturePaths {
  root: string
  configDir: string
  market: string
  pluginDir: string
  projectDir: string
  matchingFile: string
  nonMatchingFile: string
  markersFile: string
}

export function fixturePaths(root = fixtureRoot()): FixturePaths {
  const market = join(root, 'market')
  const projectDir = join(root, 'project')
  return {
    root,
    configDir: join(root, 'config'),
    market,
    pluginDir: join(market, FIXTURE.pluginId),
    projectDir,
    matchingFile: join(projectDir, 'db', 'schema.sql'),
    nonMatchingFile: join(projectDir, 'notes.txt'),
    markersFile: join(root, 'markers.json'),
  }
}

/**
 * Per-run markers. A model that invents a plausible answer must not be able to
 * score an activation it never had, so every marker is minted at BUILD time and
 * read back off disk by the case — never hardcoded here, never in git.
 */
export interface FixtureMarkers {
  /** In the gated skill's BODY. Present in a turn ⇒ that skill was materialized. */
  gatedBody: string
  /** In the control skill's BODY. */
  controlBody: string
  /** Inside the file that MATCHES the gated skill's patterns. */
  matchingFile: string
  /** Inside the file that does not. */
  nonMatchingFile: string
}

export const FIXTURE = {
  pluginId: 'cdp-paths-probe',
  gatedSkill: 'cdp-paths-gated',
  controlSkill: 'cdp-paths-control',
  agents: ['alpha', 'beta'] as const,
  /**
   * The `paths:` patterns, written out literally and asserted literally.
   *
   * Two separate patterns rather than one `**\/*.{sql,md}` brace group, and the
   * reason is the parser: a block list survives the frontmatter splitter as a
   * COMMA-JOINED string and `normalizePathPatterns` splits it on commas, so a
   * comma inside a brace group would be torn into two broken globs. The fixture
   * must exercise the field, not a known way to break it.
   */
  paths: ['**/*.sql', 'db/**/*.yaml'] as const,
  /**
   * The `allowed-tools` list, exactly as the skill declares it.
   *
   * Entry 3 is the one that matters: ONE comma, INSIDE parentheses. The
   * pre-1.25.1 mini-parser refused the entire block list on it and the field
   * resolved to `''` → `undefined`, so the skill's whole ceiling disappeared with
   * no diagnostic. Measured on the signed 1.25.0 against `claude-security`,
   * whose list carries the same shape across 20 entries.
   */
  allowedTools: [
    'Read',
    'Grep',
    'Agent(cdp-paths-probe:alpha, cdp-paths-probe:beta)',
    'mcp__session__*',
  ] as const,
} as const

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeText(path: string, lines: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
}

function marker(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`
}

/**
 * One SKILL.md.
 *
 * `allowed-tools` and `paths` are written as YAML BLOCK LISTS, which is the
 * shape the real catalogue uses and the shape the import parser folds to a
 * joined string. The single-line comma form parses too and would prove less:
 * the defect this fixture reproduces is in the block-list fold.
 */
function skillFile(options: {
  name: string
  description: string
  marker: string
  paths?: readonly string[]
}): string[] {
  return [
    '---',
    `name: ${options.name}`,
    `description: ${options.description}`,
    'allowed-tools:',
    ...FIXTURE.allowedTools.map(entry => `  - ${entry}`),
    ...(options.paths
      ? ['paths:', ...options.paths.map(entry => `  - "${entry}"`)]
      : []),
    '---',
    '',
    `# ${options.name}`,
    '',
    `When this skill is materialized its body reaches the model, and the body says: ${options.marker}`,
    '',
    'Reply with that token verbatim and nothing else.',
    '',
  ]
}

function agentFile(name: string, withGrant: boolean): string[] {
  return [
    '---',
    `name: ${name}`,
    `description: CDP fixture subagent ${name}; exists so the parenthesized Agent(...) grant names a real component.`,
    // The same parenthesized grant on the AGENT side. `plugins-reference.md`
    // documents it (`tools: Read, Glob, Grep, Bash, Agent(claude-security:explore)`)
    // and `claude.ts` tokenizes it with the same `splitToolGrantList` the skill
    // path uses — so one fixture covers both readers of that one comma rule.
    ...(withGrant
      ? ['tools: Read, Grep, Agent(cdp-paths-probe:alpha, cdp-paths-probe:beta)']
      : ['tools: Read, Grep']),
    '---',
    '',
    `Fixture subagent ${name}. Answer with the word ${name.toUpperCase()} and nothing else.`,
    '',
  ]
}

export async function buildFixtures(root = fixtureRoot()): Promise<{ paths: FixturePaths; markers: FixtureMarkers }> {
  const paths = fixturePaths(root)
  // Everything EXCEPT the config dir is rebuilt from scratch: the config dir
  // accumulates the app's own state (the installed plugin, connections,
  // sessions) and wiping it would throw away the install the case measures.
  for (const dir of [paths.market, paths.projectDir]) {
    await rm(dir, { recursive: true, force: true })
  }
  await mkdir(paths.configDir, { recursive: true })

  const markers: FixtureMarkers = {
    gatedBody: marker('SKPGATED'),
    controlBody: marker('SKPCONTROL'),
    matchingFile: marker('SKPMATCH'),
    nonMatchingFile: marker('SKPNOMATCH'),
  }
  await writeJson(paths.markersFile, markers)

  // ---- the plugin bundle ---------------------------------------------------
  // Claude format: `.claude-plugin/plugin.json` plus the DEFAULT component
  // directories. Nothing is declared in the manifest on purpose — the default
  // `skills/` and `agents/` scans are the road a real bundle takes, and a
  // declared path would measure the declaration reader instead.
  await writeJson(join(paths.pluginDir, '.claude-plugin', 'plugin.json'), {
    name: FIXTURE.pluginId,
    version: '1.0.0',
    description: 'CDP fixture: a paths-gated skill with a comma-bearing allowed-tools entry.',
    author: { name: 'Nessy CDP fixtures' },
  })
  await writeText(
    join(paths.pluginDir, 'skills', FIXTURE.gatedSkill, 'SKILL.md'),
    skillFile({
      name: FIXTURE.gatedSkill,
      description: 'CDP fixture skill gated to SQL files; reports its own body marker.',
      marker: markers.gatedBody,
      paths: FIXTURE.paths,
    }),
  )
  await writeText(
    join(paths.pluginDir, 'skills', FIXTURE.controlSkill, 'SKILL.md'),
    skillFile({
      name: FIXTURE.controlSkill,
      description: 'CDP fixture skill with no path gate; the positive control for the gated one.',
      marker: markers.controlBody,
    }),
  )
  for (const [index, name] of FIXTURE.agents.entries()) {
    await writeText(join(paths.pluginDir, 'agents', `${name}.md`), agentFile(name, index === 0))
  }

  // ---- the project the session opens --------------------------------------
  // `pathGatedSkillIsInScope` answers "no" until a tool touches a file matching
  // the patterns, so the gate half needs BOTH files: one to activate with and
  // one that must NOT activate anything.
  await writeText(paths.matchingFile, [
    '-- CDP fixture: this file MATCHES the gated skill\'s **/*.sql pattern.',
    `-- marker: ${markers.matchingFile}`,
    'CREATE TABLE probe (id INTEGER PRIMARY KEY);',
  ])
  await writeText(paths.nonMatchingFile, [
    'CDP fixture: this file matches NONE of the gated skill\'s patterns.',
    `marker: ${markers.nonMatchingFile}`,
  ])

  return { paths, markers }
}

export function readMarkers(root = fixtureRoot()): FixtureMarkers | undefined {
  const path = fixturePaths(root).markersFile
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureMarkers
}

if (import.meta.main) {
  const paths = fixturePaths()
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify({ paths, fixture: FIXTURE }, null, 2))
  } else {
    const { markers } = await buildFixtures()
    console.log(JSON.stringify({ paths, markers, fixture: FIXTURE }, null, 2))
    console.error(
      `\nStart the app against this tree:\n  NESSY_CONFIG_DIR=${paths.configDir} NESSY_CDP_PORT=9224 <the packaged app or electron:dev>\n`
      + `Then add ${paths.market} as a marketplace and install ${FIXTURE.pluginId} through the app's own RPC\n`
      + `(the SKL-P1 row in docs/testing/cdp-live-checklist.md carries the exact calls), and open ${paths.projectDir} as the session's project.\n`,
    )
  }
}
