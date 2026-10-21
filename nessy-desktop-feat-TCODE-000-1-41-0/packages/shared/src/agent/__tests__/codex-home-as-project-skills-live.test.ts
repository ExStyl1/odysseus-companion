/**
 * F1.949 (DN-273, 2026-09-29) — when the project IS the home folder, does codex report the user's own
 * `~/.agents/skills` as `user` or as `repo`? F1.845 disables every `scope: 'repo'` skill of a project the
 * host did not trust (`codexRestrictedRepoSkillsOff`), so a `repo` answer would switch the user's own
 * skills off in that one layout.
 *
 * SOURCE (github.com/openai/codex at rust-v0.156.1; strong tier): `codex-rs/ext/skills/src/host_roots.rs`
 * `resolve_skill_roots_with_home_dir` pushes the layer-stack roots first — the User layer adds
 * `$HOME/.agents/skills` with `SkillScope::User` — then appends `repo_agents_skill_roots` (every
 * `.agents/skills` from the project root to the cwd, `SkillScope::Repo`), and `dedupe_skill_roots_by_path`
 * keeps the FIRST root per path. So the same folder is `user` when it is `$HOME/.agents/skills` and `repo`
 * otherwise. `$HOME/.codex/skills` is a different case: the host's `CODEX_HOME` is its own directory, so
 * `~/.codex` is an ordinary project config folder there (`repo`), a folder Nessy's codex reads in no other
 * layout.
 *
 * MEASURED on the shipped 0.156.1 (rig `DN-273/skills-probe.ts`, then this file): HOME = the project
 * (with and without `.git`, cwd the project or a subfolder) lists `.agents/skills/<x>` as `user` and
 * `.codex/skills/<y>` as `repo`; the same project with HOME elsewhere lists both `repo` (the control that
 * shows the instrument can say `repo` for that folder). So the product's filter leaves the user's own
 * skill on and no change is needed.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCodexConfigToml } from '@nessy-agent/codex-responses-adapter/config-writer'
import { AppServer } from '../../../../codex-responses-adapter/src/__tests__/app-server-rig.ts'
import { codexRestrictedRepoSkillsOff } from '../codex-agent.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const BIN = join(REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex', `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server')
const HAVE_BIN = existsSync(BIN) && process.platform !== 'win32'
/** Several boots of a ~185 MB binary; generous because lanes share this machine. */
const BUDGET_MS = 240_000

interface ListedSkill { name: string; scope: string; enabled: boolean; path: string }

describe.if(HAVE_BIN)('F1.949 · the shipped codex-app-server when the project is the home folder', () => {
  const ROOT = HAVE_BIN ? realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1949-live-'))) : ''
  afterAll(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }) })

  function skill(dir: string, name: string): string {
    mkdirSync(join(dir, name), { recursive: true })
    const file = join(dir, name, 'SKILL.md')
    writeFileSync(file, `---\nname: ${name}\ndescription: F1949 probe skill ${name}\n---\n\n# ${name}\n`)
    return file
  }

  /** One restricted project with an `.agents/skills` and a `.codex/skills` skill; codex's own `skills/list` for the cwd. */
  async function listed(name: string, opts: { homeIsProject: boolean; git: boolean; cwdSubfolder?: boolean }): Promise<{
    answer: unknown; skills: ListedSkill[]; agentsSkill: string; codexSkill: string
  }> {
    const project = join(ROOT, name, 'home')
    const codexHome = join(ROOT, name, 'codex-home')
    const userHome = opts.homeIsProject ? project : join(ROOT, name, 'elsewhere')
    for (const dir of [project, codexHome, userHome]) mkdirSync(dir, { recursive: true })
    if (opts.git) {
      mkdirSync(join(project, '.git'), { recursive: true })
      writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    }
    const agentsSkill = skill(join(project, '.agents', 'skills'), 'f1949agents')
    const codexSkill = skill(join(project, '.codex', 'skills'), 'f1949codex')
    const cwd = opts.cwdSubfolder ? join(project, 'work') : project
    mkdirSync(cwd, { recursive: true })
    // The F1.750 entry as the host writes it: the project kept restricted.
    writeFileSync(join(codexHome, 'config.toml'), buildCodexConfigToml({
      codexHome, model: 'tgpt/deepseek-v4-flash-0731', adapterPort: 1, projectRoot: project, projectTrusted: false,
    }))
    const child = spawn(BIN, [], {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: userHome, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    const server = new AppServer(child)
    try {
      await server.request('initialize', {
        clientInfo: { name: 'nessy-f1949', title: null, version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      server.notify('initialized')
      // The request `CodexAgent.refreshCodexRestrictedRepoSkills` makes.
      const answer = await server.request('skills/list', { cwds: [cwd], forceReload: true }) as { data: Array<{ skills: ListedSkill[] }> }
      const skills = answer.data.flatMap(entry => entry.skills)
        .filter(s => s.name.startsWith('f1949'))
        .map(s => ({ name: s.name, scope: s.scope, enabled: s.enabled, path: s.path }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return { answer, skills, agentsSkill, codexSkill }
    } finally {
      server.kill()
    }
  }

  test('HOME = the project: ~/.agents/skills is `user` and stays on under the F1.845 filter; ~/.codex/skills is `repo` and is disabled', async () => {
    for (const [name, opts] of [
      ['no-git', { homeIsProject: true, git: false }],
      ['git', { homeIsProject: true, git: true }],
      ['git-subfolder-cwd', { homeIsProject: true, git: true, cwdSubfolder: true }],
    ] as const) {
      const { answer, skills, agentsSkill, codexSkill } = await listed(name, opts)
      expect(skills.map(s => `${name}: ${s.name} ${s.scope} ${s.enabled}`)).toEqual([
        `${name}: f1949agents user true`,
        `${name}: f1949codex repo true`,
      ])
      expect(skills.map(s => s.path)).toEqual([agentsSkill, codexSkill])
      // The product's own filter over codex's own answer: only the `repo` one is handed back disabled.
      expect(codexRestrictedRepoSkillsOff(answer)).toEqual([{ path: codexSkill, enabled: false }])
    }
  }, BUDGET_MS)

  test('CONTROL — the same project with HOME elsewhere: both are `repo`, and the filter disables both', async () => {
    const { answer, skills, agentsSkill, codexSkill } = await listed('elsewhere', { homeIsProject: false, git: true })
    expect(skills.map(s => `${s.name} ${s.scope} ${s.enabled}`)).toEqual(['f1949agents repo true', 'f1949codex repo true'])
    expect(codexRestrictedRepoSkillsOff(answer).map(off => `${off.path} ${off.enabled}`).sort())
      .toEqual([`${agentsSkill} false`, `${codexSkill} false`].sort())
  }, BUDGET_MS)
})
