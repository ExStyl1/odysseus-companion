/**
 * D1.363 half (b) — a cancelled trust prompt must not silence the prompt for
 * every later project in the session.
 *
 * Measure sitting 5e (packaged 1.40.0, cases `RS-80` and `RS-84`) recorded the
 * app's trust gate answering `not-shown` for every project after the first,
 * across four sessions, and read it as a consequence of the Cancel that cleared
 * a stuck modal. **Cancel is not the cause.** `ChatPage`'s `onClose` clears the
 * pending handle and writes nothing anywhere — no store, no file, no flag. The
 * silence is the gate's one-check-per-SESSION ref: the first directory a session
 * view saw consumed it, and a directory bound afterwards was skipped at the
 * guard before any RPC was made.
 *
 * The first case is the failing arm, written against the pair key: with the old
 * session-only key its third assertion is false, and the fix is what makes it
 * true. The rest pin the fail-soft rules the effect body carried, which is the
 * half that consumed the check while looking like it had asked nothing.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { detectProjectContributions } from '@nessy-agent/shared/capabilities/project-contribution-detect'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import type { ProjectContributionReport } from '@nessy-agent/shared/protocol/capabilities'
import { createOwnedRigBase } from '@nessy-agent/shared/testing/owned-temp-rig'
import {
  claimProjectTrustCheck,
  projectTrustGateKey,
  resolveProjectTrustPrompt,
  type ProjectTrustGateApi,
} from '../project-trust-gate'

/**
 * F1.850 — the real-detector rigs below live under ONE folder this file owns, and
 * `createOwnedRigBase` refuses, by name, when a directory above it carries what
 * the detector reads there (it walks to the nearest `.git` and, for claude's
 * layers, up to the filesystem root or to just below the home directory; these
 * cases leave the detector its default home, so that is the one passed here).
 */
let rigBase = ''
beforeAll(() => {
  rigBase = createOwnedRigBase('ptg-rigs-', homedir())
})
afterAll(() => {
  if (rigBase) rmSync(rigBase, { recursive: true, force: true })
})

function handle(overrides: Partial<IssuedProjectHandle> = {}): IssuedProjectHandle {
  return {
    id: 'handle-1',
    workspaceId: 'ws-1',
    displayPath: '/projects/a',
    trustState: 'unknown',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  }
}

function report(items: ProjectContributionReport['items'] = []): ProjectContributionReport {
  return { items }
}

const ONE_SKILL: ProjectContributionReport['items'] = [
  { itemType: 'SKILLS', count: 1, names: ['cdp-deploy'], sourceLabel: '.agents/skills' },
]

function api(over: Partial<ProjectTrustGateApi> = {}): ProjectTrustGateApi {
  return {
    validateProjectDirectory: async () => handle(),
    detectProjectContributions: async () => report(ONE_SKILL),
    ...over,
  }
}

describe('project trust gate — the one check per (session, directory)', () => {
  it('re-arms for a second project in the same session, and not for a re-render', () => {
    const ref: { current: string | null } = { current: null }

    // The session's first directory takes the check.
    expect(claimProjectTrustCheck(ref, 'session-a', '/projects/a')).toBe(true)
    // A re-render of the same view asks nothing — the invariant the guard exists for.
    expect(claimProjectTrustCheck(ref, 'session-a', '/projects/a')).toBe(false)
    // THE FAILING ARM: the user cancelled for /projects/a and the session is now
    // pointed at /projects/b. Keyed on the session alone this was false, and the
    // prompt was never raised again for any later project.
    expect(claimProjectTrustCheck(ref, 'session-a', '/projects/b')).toBe(true)
    expect(claimProjectTrustCheck(ref, 'session-a', '/projects/b')).toBe(false)
    // A different session is unaffected either way (the control on the old key).
    expect(claimProjectTrustCheck(ref, 'session-b', '/projects/b')).toBe(true)
  })

  it('keys on both halves, so neither alone can collide', () => {
    expect(projectTrustGateKey('s', '/a')).toBe(projectTrustGateKey('s', '/a'))
    expect(projectTrustGateKey('s', '/a')).not.toBe(projectTrustGateKey('s', '/b'))
    expect(projectTrustGateKey('s', '/a')).not.toBe(projectTrustGateKey('t', '/a'))
    // A path carrying the separator cannot forge another pair's key.
    expect(projectTrustGateKey('s', '/a","x')).not.toBe(projectTrustGateKey('s","x', '/a'))
  })
})

describe('project trust gate — what raises the prompt', () => {
  it('raises it for an unknown project that would contribute', async () => {
    const project = await resolveProjectTrustPrompt(api(), {
      workspaceId: 'ws-1',
      workingDirectory: '/projects/a',
    })
    expect(project?.id).toBe('handle-1')
  })

  it('stays silent for a project that is already decided', async () => {
    for (const trustState of ['trusted', 'untrusted'] as const) {
      const project = await resolveProjectTrustPrompt(
        api({ validateProjectDirectory: async () => handle({ trustState }) }),
        { workspaceId: 'ws-1', workingDirectory: '/projects/a' },
      )
      expect(project).toBeNull()
    }
  })

  it('stays silent for a folder with nothing in it to trust', async () => {
    const project = await resolveProjectTrustPrompt(
      api({ detectProjectContributions: async () => report() }),
      { workspaceId: 'ws-1', workingDirectory: '/projects/empty' },
    )
    expect(project).toBeNull()
  })

  it('stays silent when the directory cannot be validated, and still asks when detection fails', async () => {
    const unvalidatable = await resolveProjectTrustPrompt(
      api({ validateProjectDirectory: async () => { throw new Error('project-directory-invalid') } }),
      { workspaceId: 'ws-1', workingDirectory: '/projects/gone' },
    )
    expect(unvalidatable).toBeNull()

    // Fail-soft in ONE direction: a failed detection still asks.
    const undetectable = await resolveProjectTrustPrompt(
      api({ detectProjectContributions: async () => { throw new Error('detect-failed') } }),
      { workspaceId: 'ws-1', workingDirectory: '/projects/a' },
    )
    expect(undetectable?.id).toBe('handle-1')
  })
})

/**
 * F1.839 — the gate over the REAL detector, the chain `ChatPage`'s re-prompt
 * effect runs: `validateProjectDirectory` answers `unknown` (nobody decided), then
 * `detectProjectContributions` reads the folder.
 *
 * Since F1.750 (codex: the host writes `trust_level = "untrusted"` for a project it
 * did not trust) and F1.768 (claude: `settingSources: ['user']` unless trusted), a
 * never-asked project's `.codex/` layer, `.claude/skills` and `.claude/rules` no
 * longer load. A folder carrying one of them alone previewed as EMPTY, so the gate
 * stayed silent and the user was never offered the decision that would load them.
 */
describe('project trust gate over the real detector — layers only trust loads (F1.839)', () => {
  const roots: string[] = []
  afterEach(() => {
    while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true })
  })

  function folder(files: Record<string, string>): string {
    const root = mkdtempSync(join(rigBase, 'ptg-f1839-'))
    roots.push(root)
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), content)
    }
    return root
  }

  async function gateFor(root: string): Promise<IssuedProjectHandle | null> {
    return resolveProjectTrustPrompt(
      api({
        validateProjectDirectory: async () => handle({ displayPath: root }),
        detectProjectContributions: async () => detectProjectContributions(root),
      }),
      { workspaceId: 'ws-1', workingDirectory: root },
    )
  }

  const layers: Array<[string, Record<string, string>]> = [
    ['.codex/config.toml declaring an MCP server', { '.codex/config.toml': '[mcp_servers.docs]\ncommand = "docs-server"\n' }],
    ['.codex/hooks.json', { '.codex/hooks.json': '{"hooks":{}}' }],
    ['.codex/rules/*.rules', { '.codex/rules/team.rules': 'prefix_rule(pattern=["touch"], decision="allow")' }],
    ['.codex/agents/*.toml', { '.codex/agents/reviewer.toml': 'name = "reviewer"' }],
    ['.claude/skills/<name>/SKILL.md', { '.claude/skills/deploy/SKILL.md': '---\nname: deploy\n---\nBody' }],
    ['.claude/rules/<name>.md', { '.claude/rules/testing.md': '# rule' }],
  ]

  it.each(layers)('asks for a folder whose only contribution is %s', async (_label, files) => {
    expect((await gateFor(folder(files)))?.id).toBe('handle-1')
  })

  it('still asks for .nessy-agent/hooks.json (the control) and stays silent for an empty folder (the 1.40.0 rule)', async () => {
    expect((await gateFor(folder({ '.nessy-agent/hooks.json': '{}' })))?.id).toBe('handle-1')
    expect(await gateFor(folder({ 'README.md': 'not an entry point' }))).toBeNull()
    expect(await gateFor(folder({}))).toBeNull()
  })

  it('never decides: an already-decided project is not re-asked, whatever the folder carries', async () => {
    const root = folder({ '.codex/config.toml': '', '.claude/rules/testing.md': '# rule' })
    for (const trustState of ['trusted', 'untrusted'] as const) {
      const project = await resolveProjectTrustPrompt(
        api({
          validateProjectDirectory: async () => handle({ trustState, displayPath: root }),
          detectProjectContributions: async () => detectProjectContributions(root),
        }),
        { workspaceId: 'ws-1', workingDirectory: root },
      )
      expect(project).toBeNull()
    }
  })
})

/**
 * F1.844 — the same chain for a project that is a SUBFOLDER of a git repository:
 * `packages/app` carries nothing, the repository ROOT carries the layer. Codex
 * reads every `.codex/` and the AGENTS.md chain from the working directory up to
 * its project root (the nearest `.git`), claude reads `.claude/skills` and the
 * CLAUDE.md chain from the parents too — and since F1.750/F1.768 only for a
 * trusted project. The subfolder previewed as EMPTY, so the gate stayed silent
 * and the root's layers stopped loading (measured on both shipped binaries,
 * `work/wjcritpp/`).
 */
describe('project trust gate over the real detector — a subfolder of a repository (F1.844)', () => {
  const roots: string[] = []
  afterEach(() => {
    while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true })
  })

  /** A folder tree under an owned temp root; returns `<root>/packages/app`, created empty. */
  function subfolderOf(files: Record<string, string>): string {
    const root = mkdtempSync(join(rigBase, 'ptg-f1844-'))
    roots.push(root)
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), content)
    }
    const app = join(root, 'packages', 'app')
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'index.ts'), 'export {}\n')
    return app
  }

  async function gateFor(dir: string): Promise<IssuedProjectHandle | null> {
    return resolveProjectTrustPrompt(
      api({
        validateProjectDirectory: async () => handle({ displayPath: dir }),
        detectProjectContributions: async () => detectProjectContributions(dir),
      }),
      { workspaceId: 'ws-1', workingDirectory: dir },
    )
  }

  const GIT = { '.git/HEAD': 'ref: refs/heads/main\n' }
  const rootLayers: Array<[string, Record<string, string>]> = [
    ['.codex/config.toml declaring an MCP server', { '.codex/config.toml': '[mcp_servers.docs]\ncommand = "docs-server"\n' }],
    ['.codex/rules/*.rules', { '.codex/rules/team.rules': 'prefix_rule(pattern=["touch"], decision="allow")' }],
    ['AGENTS.md', { 'AGENTS.md': '# repository conventions' }],
    ['CLAUDE.md', { 'CLAUDE.md': '# repository conventions' }],
    ['.claude/skills/<name>/SKILL.md', { '.claude/skills/deploy/SKILL.md': '---\nname: deploy\n---\nBody' }],
    ['.mcp.json', { '.mcp.json': '{"mcpServers":{"docs":{"command":"docs-server"}}}' }],
  ]

  it.each(rootLayers)('asks for a subfolder whose repository root carries only %s', async (_label, files) => {
    expect((await gateFor(subfolderOf({ ...GIT, ...files })))?.id).toBe('handle-1')
  })

  it('stays silent for a subfolder of a repository with nothing at the root, and of a folder that is no repository (codex reads no parent there)', async () => {
    expect(await gateFor(subfolderOf({ ...GIT, 'README.md': '# repo' }))).toBeNull()
    expect(await gateFor(subfolderOf({ '.codex/config.toml': '[mcp_servers.docs]\ncommand = "docs-server"\n' }))).toBeNull()
  })
})

/**
 * F1.847 — the same chain one step further up, where claude reads and F1.844's walk
 * did not: a folder `P/proj` whose parent `P` is in no repository, and a subfolder of a
 * repository `Q/R` whose PARENT `Q` carries the layer. Before this plan the claude child
 * loaded those parents' CLAUDE.md chain, `.claude/rules` and `.mcp.json` (and, outside a
 * repository, their skills, agents and commands); since F1.768 only for a trusted
 * project, and the folder previewed as EMPTY, so the gate stayed silent (measured on the
 * vendored 2.1.267, `work/wjcritqq/`).
 */
describe('project trust gate over the real detector — claude\'s parent folders (F1.847)', () => {
  const roots: string[] = []
  afterEach(() => {
    while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true })
  })

  /** Files under an owned temp root; returns `<root>/<selected>`, created with one plain file. */
  function tree(files: Record<string, string>, selected: string): string {
    const root = mkdtempSync(join(rigBase, 'ptg-f1847-'))
    roots.push(root)
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), content)
    }
    const dir = join(root, selected)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.ts'), 'export {}\n')
    return dir
  }

  async function gateFor(dir: string, trustState: IssuedProjectHandle['trustState'] = 'unknown'): Promise<IssuedProjectHandle | null> {
    return resolveProjectTrustPrompt(
      api({
        validateProjectDirectory: async () => handle({ trustState, displayPath: dir }),
        detectProjectContributions: async () => detectProjectContributions(dir),
      }),
      { workspaceId: 'ws-1', workingDirectory: dir },
    )
  }

  const REPO = { 'Q/R/.git/HEAD': 'ref: refs/heads/main\n' }
  const parentLayers: Array<[string, Record<string, string>, string]> = [
    ['a non-repository parent\'s CLAUDE.md', { 'P/CLAUDE.md': '# my folder conventions' }, 'P/proj'],
    ['a non-repository parent\'s .claude/skills/<name>/SKILL.md', { 'P/.claude/skills/deploy/SKILL.md': '---\nname: deploy\n---\nBody' }, 'P/proj'],
    ['a non-repository parent\'s .mcp.json', { 'P/.mcp.json': '{"mcpServers":{"docs":{"command":"docs-server"}}}' }, 'P/proj'],
    ['the CLAUDE.md of the folder above a repository root', { ...REPO, 'Q/CLAUDE.md': '# team conventions' }, 'Q/R/packages/app'],
    ['the .claude/rules of the folder above a repository root', { ...REPO, 'Q/.claude/rules/style.md': '# rule' }, 'Q/R/packages/app'],
  ]

  it.each(parentLayers)('asks for a folder when only %s carries anything', async (_label, files, selected) => {
    expect((await gateFor(tree(files, selected)))?.id).toBe('handle-1')
  })

  it('stays silent when the parents carry nothing claude reads there, and never re-asks a decided project', async () => {
    expect(await gateFor(tree({ 'P/README.md': '# notes' }, 'P/proj'))).toBeNull()
    expect(await gateFor(tree({ 'P/AGENTS.md': '# a', 'P/.codex/config.toml': '[mcp_servers.docs]\ncommand = "docs-server"\n' }, 'P/proj'))).toBeNull()
    expect(await gateFor(tree({ ...REPO, 'Q/.claude/skills/deploy/SKILL.md': '---\nname: deploy\n---\nBody' }, 'Q/R/packages/app'))).toBeNull()
    const decided = tree({ 'P/CLAUDE.md': '# my folder conventions' }, 'P/proj')
    for (const trustState of ['trusted', 'untrusted'] as const) expect(await gateFor(decided, trustState)).toBeNull()
  })
})
