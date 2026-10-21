import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import { CapabilityTrustStore } from '@nessy-agent/shared/capabilities/trust-store'
import {
  createPluginBundleValidator,
  PluginManagementServiceV2,
  PluginStoreV2,
} from '@nessy-agent/shared/plugins'
import {
  runPluginCommand,
  type MarketplaceRegistryApi,
  type PluginInventoryRow,
  type PluginMutationApi,
} from './plugin.ts'

let dir: string

/** Any network reach from a validate is a test failure, not a slow test. */
const forbidNetwork = (async () => {
  throw new Error('network forbidden')
}) as unknown as typeof fetch

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-plugin-'))
})

afterEach(async () => { await installs.settle() // F1.424 — never remove a root under an install still copying into it
  rmSync(dir, { recursive: true, force: true })
})

/**
 * The real validator, pointed at a temporary staging root. These are the door's
 * tests, so they run the production composition rather than a stub — a stub would
 * prove the renderer and not the verb.
 */
function realValidator() {
  return createPluginBundleValidator({
    fetchImpl: forbidNetwork,
    baseTempDir: join(dir, 'staging'),
  }).validate
}

async function expectStoreUntouched(): Promise<void> {
  const root = join(dir, 'plugins')
  const store = new PluginStoreV2({ rootDirectory: root })
  expect(existsSync(join(root, 'installed.json'))).toBe(false)
  expect(existsSync(join(root, 'cache'))).toBe(false)
  const registry = await store.readInstalledRegistry()
  expect(registry.plugins).toEqual([])
  expect(registry.active).toEqual({})
  if (existsSync(join(dir, 'staging'))) expect(readdirSync(join(dir, 'staging'))).toEqual([])
}

describe('nessy-general-agent plugin validate', () => {
  it('exits 0 on a good bundle and says it was not installed', async () => {
    const result = await runPluginCommand(['validate', createGoodBundle()], {
      validate: realValidator(),
    })

    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('PASS')
    expect(result.text).toContain('This bundle was not installed.')
    expect(result.text).toContain('Toolkit 1.0.0')
    await expectStoreUntouched()
  })

  it('exits 1 on a broken bundle, printing every diagnostic code', async () => {
    // `plugins/cli-reference.md#plugin-validate` — validate exists to tell an author which field
    // is wrong, so the codes are the product; a bare exit code is not enough.
    const result = await runPluginCommand(['validate', createBrokenBundle()], {
      validate: realValidator(),
    })

    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('FAIL')
    expect(result.text).toContain('plugin.manifest.missing_id')
    expect(result.text).toContain('plugin.manifest.capabilities_not_array')
    await expectStoreUntouched()
  })

  it('--strict turns a warning-only bundle red and names the rule that did it', async () => {
    // `:486` — "Pass `--strict` to treat warnings as errors." `:479` — a
    // warning-only plugin "still passes validation and loads at runtime".
    const path = createWarningOnlyBundle()

    const lenient = await runPluginCommand(['validate', path], { validate: realValidator() })
    expect(lenient.exitCode).toBe(0)
    expect(lenient.text).toContain('PASS')

    const strict = await runPluginCommand(['validate', path, '--strict'], {
      validate: realValidator(),
    })
    expect(strict.exitCode).toBe(1)
    expect(strict.text).toContain('strict: warnings treated as errors')
    expect(strict.text).toContain('plugin.format.claude_user_config_incomplete')
    await expectStoreUntouched()
  })

  it('--json pins a scriptable shape for both verdicts', async () => {
    const good = await runPluginCommand(['validate', createGoodBundle()], {
      json: true,
      validate: realValidator(),
    })
    expect(good.exitCode).toBe(0)
    const parsedGood = JSON.parse(good.text) as Record<string, unknown>
    expect(parsedGood.ok).toBe(true)
    expect(parsedGood.strict).toBe(false)
    expect(parsedGood.errorCount).toBe(0)
    expect(parsedGood.plugin).toEqual({
      pluginId: 'toolkit',
      name: 'Toolkit',
      version: '1.0.0',
      capabilityKinds: ['skill'],
    })

    const bad = await runPluginCommand(['validate', createBrokenBundle(), '--strict'], {
      json: true,
      validate: realValidator(),
    })
    expect(bad.exitCode).toBe(1)
    const parsedBad = JSON.parse(bad.text) as Record<string, unknown>
    expect(parsedBad.ok).toBe(false)
    expect(parsedBad.strict).toBe(true)
    expect(parsedBad.plugin).toBeUndefined()
    expect((parsedBad.diagnostics as { code: string }[]).map(d => d.code).sort()).toEqual([
      'plugin.manifest.capabilities_not_array',
      'plugin.manifest.missing_id',
    ])
  })

  it('refuses a missing path and an unknown verb without touching the store', async () => {
    const noPath = await runPluginCommand(['validate'], { validate: realValidator() })
    expect(noPath.exitCode).toBe(1)
    expect(noPath.text).toContain('needs a bundle path')

    const unknown = await runPluginCommand(['frobnicate'], { validate: realValidator() })
    expect(unknown.exitCode).toBe(1)
    expect(unknown.text).toContain('Unknown plugin verb: frobnicate')

    // A bare `plugin` is a usage error, not a silent no-op.
    const bare = await runPluginCommand([], { validate: realValidator() })
    expect(bare.exitCode).toBe(1)
    expect(bare.text).toContain('Usage: nessy-general-agent plugin')

    expect((await runPluginCommand(['help'], {})).exitCode).toBe(0)
    await expectStoreUntouched()
  })

  it('reads the agent files in the directory it is given, manifest or not', async () => {
    // P6.317. `sub-agents.md` § *Check an `agents` directory before a session*:
    // "To find files in an `agents` directory whose frontmatter doesn't parse,
    // run `claude plugin validate` against the directory, for example
    // `.claude/agents` or `~/.claude/agents`."
    const bare = createAgentsDir('bare-agents', {
      'good.md': '---\nname: good\ndescription: Fine.\n---\nBody.\n',
      'bad.md': '---\nname: bad\ndescription: Broken.\nmaxTurns: -3\n---\nBody.\n',
    })

    const result = await runPluginCommand(['validate', bare], { validate: realValidator() })

    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('plugin.validate.agent_frontmatter_invalid')
    expect(result.text).toContain('bad.md')
    expect(result.text).toContain('Checked 2 agent file(s)')
    // The missing-manifest error is not a finding once agent files were found:
    // `plugin-marketplaces.md` § *Read the validation results* defines
    // `No manifest found in directory` as "no `plugin.json` or
    // `marketplace.json` there, and no skill, agent, or command file".
    expect(result.text).not.toContain('plugin.format.unsupported_format')
    expect(result.text).toContain('No plugin manifest here')
    await expectStoreUntouched()
  })

  it('passes a clean agents directory, and does not flag a file with no name', async () => {
    // The page's own carve-out, verbatim: validate "doesn't flag a file whose
    // frontmatter parses but has no `name`". `AGENTS.md` beside the definitions
    // is an instruction file, never a definition, so it is not read either.
    const clean = createAgentsDir('clean-agents', {
      'named.md': '---\nname: named\ndescription: Fine.\n---\nBody.\n',
      'nameless.md': '---\ndescription: No name at all.\n---\nBody.\n',
      'AGENTS.md': '# Notes for humans, not an agent definition.\n',
    })

    const result = await runPluginCommand(['validate', clean], { validate: realValidator() })

    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('PASS')
    expect(result.text).toContain('Checked 2 agent file(s)')
    expect(result.text).toContain('Skill and command frontmatter was not checked.')
  })

  it('still reports the missing manifest when the directory holds no agent file', async () => {
    // The control that keeps the scan from swallowing the manifest error.
    const empty = join(dir, 'nothing-here')
    mkdirSync(empty, { recursive: true })

    const result = await runPluginCommand(['validate', empty], { validate: realValidator() })

    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('plugin.format.unsupported_format')
    expect(result.text).not.toContain('Checked')
    expect(result.text).toContain('This bundle was not installed.')
  })

  it('reads an `agents` folder under a plugin bundle that otherwise passes', async () => {
    // MEASURED at HEAD before the build: a directory holding `agents/` and no
    // manifest already validated as a `raw` bundle and PASSED with
    // `Capability kinds: agent` while one of its agent files had unparseable
    // frontmatter. The scan runs for an accepted bundle too, which is the page's
    // first table row: a plugin with a `plugin.json` is checked including "the
    // `skills`, `agents`, and `commands` directories at the plugin root".
    const root = createGoodBundle()
    mkdirSync(join(root, 'agents'), { recursive: true })
    writeFileSync(
      join(root, 'agents', 'wrong.md'),
      '---\nname: wrong\ndescription: Broken.\npermissionMode: nonsense\n---\nBody.\n',
    )

    const result = await runPluginCommand(['validate', root], { validate: realValidator() })

    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('plugin.validate.agent_frontmatter_invalid')
    expect(result.text).toContain('wrong.md')
    expect(result.text).toContain('This bundle was not installed.')
  })

  it('does not reach the network for a --strict flag placed before the path', async () => {
    // Flag order must not decide which argument is the bundle path.
    const result = await runPluginCommand(['validate', '--strict', createGoodBundle()], {
      validate: realValidator(),
    })
    expect(result.text).toContain('(strict)')
    expect(result.exitCode).toBe(0)
  })
})

/**
 * Install a local fixture bundle into a temporary store, then collect the
 * inventory the same way `collectInventory` does — real store, real status API,
 * real activation policy, just rooted in the temp dir. Nothing is fetched from a
 * network: the source is a directory this test wrote.
 */
async function installFixtureAndCollect(
  bundlePath: string,
  options: { enableGlobally?: boolean } = {},
): Promise<{
  rows: PluginInventoryRow[]
  pluginKey: string
  /** Returned so a mutating verb runs the PRODUCTION guard, not a stub of it. */
  service: PluginManagementServiceV2
  policyStore: CapabilityPolicyStore
}> {
  const store = new PluginStoreV2({ rootDirectory: join(dir, 'plugins') })
  const policyStore = new CapabilityPolicyStore({
    globalPath: join(dir, 'capabilities.json'),
    workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
    workspaceIds: () => [],
  })
  const service = installs.track(new PluginManagementServiceV2({
    store,
    policyStore,
    trustStore: new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') }),
    fetchImpl: forbidNetwork,
    baseTempDir: join(dir, 'staging'),
  }))
  const installed = await service.install({ kind: 'local-path', path: bundlePath })
  expect(installed.ok).toBe(true)
  const pluginKey = installed.installed?.pluginKey ?? ''
  if (options.enableGlobally) await service.enable(pluginKey, { kind: 'global' })

  const status = await service.status()
  const registry = await store.readInstalledRegistry()
  const rows: PluginInventoryRow[] = status.installed.map(summary => {
    const entry = registry.plugins.find(
      candidate => candidate.pluginInstanceId === summary.activeInstanceId,
    )
    return {
      pluginKey: summary.pluginKey,
      pluginId: summary.pluginId,
      name: summary.name,
      version: summary.version,
      marketplaceId: summary.marketplaceId,
      ...(summary.description ? { description: summary.description } : {}),
      enabled: policyStore.resolveScopes({ pluginKey: summary.pluginKey }).global,
      components: (entry?.manifest.capabilities ?? []).map(capability => ({
        capabilityId: capability.id,
        kind: capability.kind,
        name: capability.displayName ?? capability.id,
        ...(capability.description ? { description: capability.description } : {}),
      })),
      diagnostics: summary.diagnostics.map(diagnostic => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
      })),
    }
  })
  return { rows, pluginKey, service, policyStore }
}

describe('nessy-general-agent plugin list', () => {
  it('lists a really-installed plugin with version, marketplace and enable status', async () => {
    // `:1078` — "List installed plugins with their version, source marketplace,
    // and enable status."
    const { rows } = await installFixtureAndCollect(createInventoryBundle(), { enableGlobally: true })
    const result = await runPluginCommand(['list'], { collect: async () => rows })

    expect(result.exitCode).toBe(0)
    const [header, row] = result.text.split('\n')
    expect(header).toContain('NAME')
    expect(header).toContain('VERSION')
    expect(header).toContain('MARKETPLACE')
    expect(header).toContain('ENABLED (GLOBAL)')
    expect(row).toContain('Inventory Kit')
    expect(row).toContain('2.3.0')
    expect(row).toContain('local')
    expect(row).toContain('enabled')
  })

  it('reports an installed-but-not-enabled plugin as unset rather than disabled', async () => {
    // `unset` and `disabled` are different states — an explicit `enabled: false`
    // is a terminal suppression, no record at all is not.
    const { rows } = await installFixtureAndCollect(createInventoryBundle())
    const result = await runPluginCommand(['list'], { collect: async () => rows })
    expect(result.text).toContain('unset')
  })

  it('--json pins the list shape', async () => {
    const { rows, pluginKey } = await installFixtureAndCollect(createInventoryBundle(), {
      enableGlobally: true,
    })
    const result = await runPluginCommand(['list'], { json: true, collect: async () => rows })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.text)).toEqual([{
      pluginKey,
      pluginId: 'inventory-kit',
      name: 'Inventory Kit',
      version: '2.3.0',
      marketplaceId: 'local',
      enabled: 'enabled',
      description: 'Fixture plugin for the CLI inventory verbs',
      // Five in the documented groups, plus the workflow reported under Other.
      componentCount: 6,
      diagnosticCount: 0,
    }])
  })

  it('says so plainly when nothing is installed, and `ls` is the same verb', async () => {
    const empty = await runPluginCommand(['list'], { collect: async () => [] })
    expect(empty.exitCode).toBe(0)
    expect(empty.text).toBe('No plugins installed.')

    // `:1097` — "`ls` as a shorthand for `list`".
    const shorthand = await runPluginCommand(['ls'], { collect: async () => [] })
    expect(shorthand.text).toBe(empty.text)

    const json = await runPluginCommand(['list'], { json: true, collect: async () => [] })
    expect(JSON.parse(json.text)).toEqual([])
  })
})

describe('nessy-general-agent plugin details', () => {
  it('groups the component inventory the way the page documents', async () => {
    // `:1101` — five groups, and "The Skills group includes both
    // `skills/` and `commands/` entries", so the prompt-command lands in Skills.
    const { rows } = await installFixtureAndCollect(createInventoryBundle())
    const result = await runPluginCommand(['details', 'Inventory Kit'], {
      collect: async () => rows,
    })

    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('Inventory Kit 2.3.0')
    expect(result.text).toContain('Skills (2)')
    expect(result.text).toContain('Agents (1)')
    expect(result.text).toContain('Hooks (1)')
    expect(result.text).toContain('MCP servers (1)')
    expect(result.text).toContain('LSP servers (0)')
    expect(result.text).toContain('Projected token cost')
    expect(result.text).toContain('Always-on:')
    // The estimate must never be presented as a measurement.
    expect(result.text).toContain('character-based estimate, not a count_tokens result')
    expect(result.text).toContain('On-invoke cost is not computed')
  })

  it('--json pins the details shape, including the cost method', async () => {
    const { rows, pluginKey } = await installFixtureAndCollect(createInventoryBundle())
    const result = await runPluginCommand(['details', pluginKey], {
      json: true,
      collect: async () => rows,
    })

    const parsed = JSON.parse(result.text) as {
      pluginKey: string
      components: { group: string; items: { kind: string; name: string; alwaysOnTokens: number }[] }[]
      otherComponents: { kind: string }[]
      tokenCost: Record<string, unknown>
    }
    expect(parsed.pluginKey).toBe(pluginKey)
    expect(parsed.components.map(group => group.group)).toEqual([
      'Skills', 'Agents', 'Hooks', 'MCP servers', 'LSP servers',
    ])
    expect(parsed.components[0]?.items.map(item => item.kind).sort())
      .toEqual(['prompt-command', 'skill'])
    for (const group of parsed.components) {
      for (const item of group.items) expect(item.alwaysOnTokens).toBeGreaterThan(0)
    }
    // A kind outside the documented five is reported, not dropped.
    expect(parsed.otherComponents.map(component => component.kind)).toEqual(['workflow'])
    expect(parsed.tokenCost).toEqual({
      alwaysOnTokens: expect.any(Number),
      method: 'character-estimate',
      onInvokeTokens: null,
    })
  })

  it('resolves a plugin by name, id or pluginKey and refuses an unknown one', async () => {
    const { rows, pluginKey } = await installFixtureAndCollect(createInventoryBundle())
    const collect = async () => rows

    for (const wanted of ['Inventory Kit', 'inventory-kit', pluginKey]) {
      expect((await runPluginCommand(['details', wanted], { collect })).exitCode).toBe(0)
    }

    const missing = await runPluginCommand(['details', 'nope'], { collect })
    expect(missing.exitCode).toBe(1)
    expect(missing.text).toBe('No installed plugin named: nope')

    const noName = await runPluginCommand(['details'], { collect })
    expect(noName.exitCode).toBe(1)
    expect(noName.text).toContain('needs a plugin name')
  })
})

describe('nessy-general-agent plugin enable', () => {
  it('writes the global enable through the production service', async () => {
    // `plugins-reference.md` § *plugin enable* — "Enable a disabled plugin." The
    // service here is the real one, so what is proven is the write, not the print.
    // Installed-and-never-enabled is `unset`, which is the state the verb has to
    // move: P6.622's defect was that nothing in the CLI could move it forward.
    const { rows, pluginKey, service, policyStore } = await installFixtureAndCollect(
      createInventoryBundle(),
    )
    expect(policyStore.resolveScopes({ pluginKey }).global).not.toBe('enabled')

    const result = await runPluginCommand(['enable', 'Inventory Kit'], {
      collect: async () => rows,
      enable: key => service.enable(key, { kind: 'global' }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Enabled (global): Inventory Kit')
    expect(policyStore.resolveScopes({ pluginKey }).global).toBe('enabled')
  })

  it('--json pins the enable shape, naming the scope it wrote', async () => {
    const { rows, pluginKey, service } = await installFixtureAndCollect(createInventoryBundle())
    const result = await runPluginCommand(['enable', pluginKey], {
      json: true,
      collect: async () => rows,
      enable: key => service.enable(key, { kind: 'global' }),
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.text)).toEqual({
      pluginKey,
      pluginId: 'inventory-kit',
      name: 'Inventory Kit',
      scope: 'global',
      enabled: 'enabled',
    })
  })

  it('lists what else was enabled, in text and in --json, and says nothing when nothing else moved', async () => {
    // `plugin-dependencies.md` § *Enable or disable a plugin with dependencies*:
    // "The success message lists what else was enabled along with the plugin you
    // named." P6.622 could not satisfy that clause and named it; P6.628 widened
    // the service's summary so this verb reads the set rather than deriving it.
    // The double asserted here is the SHAPE the production service now returns —
    // the service side is pinned by `management-service-v2.test.ts`.
    const { rows } = await installFixtureAndCollect(createInventoryBundle())

    const withDeps = await runPluginCommand(['enable', 'Inventory Kit'], {
      collect: async () => rows,
      enable: async () => ({ enabledDependencies: ['secrets-vault@acme', 'audit-log@acme'] }),
    })
    expect(withDeps.exitCode).toBe(0)
    expect(withDeps.text).toBe(
      'Enabled (global): Inventory Kit\n  Also enabled: secrets-vault@acme, audit-log@acme',
    )

    const json = await runPluginCommand(['enable', 'Inventory Kit'], {
      json: true,
      collect: async () => rows,
      enable: async () => ({ enabledDependencies: ['secrets-vault@acme'] }),
    })
    expect(JSON.parse(json.text).enabledDependencies).toEqual(['secrets-vault@acme'])

    // Nothing else moved: no line, and no empty key in the JSON — an empty list
    // printed as "Also enabled:" would read as a truncated message.
    const alone = await runPluginCommand(['enable', 'Inventory Kit'], {
      json: true,
      collect: async () => rows,
      enable: async () => ({}),
    })
    expect(Object.keys(JSON.parse(alone.text))).not.toContain('enabledDependencies')
  })

  it('surfaces the service refusal verbatim and exits non-zero', async () => {
    // `plugin-dependencies.md` § *Enable or disable a plugin with dependencies*:
    // "A dependency is not installed | Enable fails and prints the `claude plugin
    // install` command for each missing dependency." The refusal is the service's
    // to word; this verb prints it rather than paraphrasing.
    const { rows } = await installFixtureAndCollect(createInventoryBundle())
    const refusal = 'plugin.manage.dependency-missing:secrets-vault: '
      + 'nessy-general-agent plugin install secrets-vault'

    const result = await runPluginCommand(['enable', 'Inventory Kit'], {
      collect: async () => rows,
      enable: async () => { throw new Error(refusal) },
    })

    expect(result.exitCode).toBe(1)
    expect(result.text).toBe(refusal)
  })

  it('refuses an unknown name and a missing name without touching anything', async () => {
    const missing = await runPluginCommand(['enable', 'nope'], { collect: async () => [] })
    expect(missing.exitCode).toBe(1)
    expect(missing.text).toBe('No installed plugin named: nope')

    const noName = await runPluginCommand(['enable'], { collect: async () => [] })
    expect(noName.exitCode).toBe(1)
    expect(noName.text).toContain('needs a plugin name')
    expect(noName.text).toContain('enable <name>')
    await expectStoreUntouched()
  })

  it('round-trips with disable, which is the asymmetry P6.622 closes', async () => {
    // The scripting trap: the refusal remedy chains `plugin disable`, and before
    // this row there was no verb that could undo it. Both sides run the
    // production service, so this is the real policy store moving twice.
    const { rows, pluginKey, service, policyStore } = await installFixtureAndCollect(
      createInventoryBundle(),
      { enableGlobally: true },
    )
    expect(policyStore.resolveScopes({ pluginKey }).global).toBe('enabled')

    const off = await runPluginCommand(['disable', pluginKey], {
      collect: async () => rows,
      disable: key => service.disable(key, { kind: 'global' }),
    })
    expect(off.exitCode).toBe(0)
    expect(policyStore.resolveScopes({ pluginKey }).global).toBe('disabled')

    const on = await runPluginCommand(['enable', pluginKey], {
      collect: async () => rows,
      enable: key => service.enable(key, { kind: 'global' }),
    })
    expect(on.exitCode).toBe(0)
    expect(policyStore.resolveScopes({ pluginKey }).global).toBe('enabled')
  })
})

describe('nessy-general-agent plugin disable', () => {
  it('writes the global disable through the production service', async () => {
    // `plugins-reference.md` § *plugin disable* — "Disable a plugin without
    // uninstalling it." The service here is the real one, so what is proven is
    // the write, not the print.
    const { rows, pluginKey, service, policyStore } = await installFixtureAndCollect(
      createInventoryBundle(),
      { enableGlobally: true },
    )
    expect(policyStore.resolveScopes({ pluginKey }).global).toBe('enabled')

    const result = await runPluginCommand(['disable', 'Inventory Kit'], {
      collect: async () => rows,
      disable: key => service.disable(key, { kind: 'global' }),
    })

    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Disabled (global): Inventory Kit')
    expect(policyStore.resolveScopes({ pluginKey }).global).toBe('disabled')

    // Still installed: `disable` is not `uninstall`.
    const registry = await new PluginStoreV2({ rootDirectory: join(dir, 'plugins') })
      .readInstalledRegistry()
    expect(registry.plugins.map(entry => entry.pluginKey)).toEqual([pluginKey])
  })

  it('--json pins the disable shape, naming the scope it wrote', async () => {
    const { rows, pluginKey, service } = await installFixtureAndCollect(createInventoryBundle(), {
      enableGlobally: true,
    })
    const result = await runPluginCommand(['disable', pluginKey], {
      json: true,
      collect: async () => rows,
      disable: key => service.disable(key, { kind: 'global' }),
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.text)).toEqual({
      pluginKey,
      pluginId: 'inventory-kit',
      name: 'Inventory Kit',
      scope: 'global',
      enabled: 'disabled',
    })
  })

  it('surfaces the dependent-blocking refusal verbatim and exits non-zero', async () => {
    // The guard's own message carries the page's chained remedy; the verb prints
    // it rather than paraphrasing, so there is one copy of that text in the tree.
    const { rows } = await installFixtureAndCollect(createInventoryBundle(), {
      enableGlobally: true,
    })
    const refusal = 'plugin.manage.dependency-required-by:dependent:'
      + 'inventory-kit is still required by dependent. '
      + 'Disable that plugin first, or disable everything together: '
      + 'nessy-general-agent plugin disable dependent && '
      + 'nessy-general-agent plugin disable inventory-kit'

    const result = await runPluginCommand(['disable', 'Inventory Kit'], {
      collect: async () => rows,
      disable: async () => { throw new Error(refusal) },
    })

    expect(result.exitCode).toBe(1)
    expect(result.text).toBe(refusal)
  })

  it('every verb the refusal remedy names is a verb this dispatcher has', async () => {
    // P6.559's actual defect: the remedy told the user to run a verb that did not
    // exist. Read the verbs back out of the guard rather than restating them, so
    // a reworded remedy naming an undispatched verb turns THIS red.
    const guard = readFileSync(
      join(import.meta.dir, '../../../packages/shared/src/plugins/management-service-v2.ts'),
      'utf8',
    )
    const named = [...guard.matchAll(/nessy-general-agent plugin ([a-z][a-z-]*)/g)]
      .map(match => match[1]!)
    // Positive control: a moved remedy must not read as "nothing to check".
    expect(named).toContain('disable')

    for (const verb of new Set(named)) {
      const result = await runPluginCommand([verb], { collect: async () => [] })
      expect(result.text).not.toContain('Unknown plugin verb')
    }
  })

  it('refuses an unknown name and a missing name without touching anything', async () => {
    const missing = await runPluginCommand(['disable', 'nope'], { collect: async () => [] })
    expect(missing.exitCode).toBe(1)
    expect(missing.text).toBe('No installed plugin named: nope')

    const noName = await runPluginCommand(['disable'], { collect: async () => [] })
    expect(noName.exitCode).toBe(1)
    expect(noName.text).toContain('needs a plugin name')
    expect(noName.text).toContain('disable <name>')
    await expectStoreUntouched()
  })
})

/**
 * A local fixture bundle covering four of the five documented detail groups plus
 * one kind outside them. Never fetched — `plugin details` must be provable
 * without installing anything from a network.
 */
function createInventoryBundle(): string {
  const root = join(dir, 'inventory')
  mkdirSync(join(root, 'skills', 'review'), { recursive: true })
  mkdirSync(join(root, 'agents'), { recursive: true })
  mkdirSync(join(root, 'commands'), { recursive: true })
  mkdirSync(join(root, 'workflows'), { recursive: true })
  mkdirSync(join(root, 'hooks'), { recursive: true })
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'inventory-kit',
    name: 'Inventory Kit',
    version: '2.3.0',
    description: 'Fixture plugin for the CLI inventory verbs',
    capabilities: [
      {
        kind: 'skill',
        id: 'review',
        displayName: 'review',
        description: 'Review a change',
        skill: { slug: 'review', path: 'skills/review/SKILL.md' },
      },
      {
        kind: 'prompt-command',
        id: 'ship',
        displayName: 'ship',
        description: 'Ship it',
        promptCommand: { name: 'ship', path: 'commands/ship.md' },
      },
      {
        kind: 'agent',
        id: 'reviewer',
        displayName: 'reviewer',
        description: 'Reviewing subagent',
        agent: { name: 'reviewer', path: 'agents/reviewer.md' },
      },
      {
        kind: 'hook',
        id: 'guard',
        displayName: 'guard',
        description: 'PreToolUse guard',
        hook: { event: 'PreToolUse', command: 'echo guard' },
      },
      {
        kind: 'mcp',
        id: 'notes',
        displayName: 'notes',
        description: 'Notes MCP server',
        mcp: { serverName: 'notes', transport: 'http', url: 'https://notes.example/mcp' },
      },
      {
        kind: 'workflow',
        id: 'nightly',
        displayName: 'nightly',
        description: 'Nightly workflow',
        workflow: { name: 'nightly', path: 'workflows/nightly.ts' },
      },
    ],
  }))
  writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '# Review')
  writeFileSync(join(root, 'agents', 'reviewer.md'), '# Reviewer')
  writeFileSync(join(root, 'commands', 'ship.md'), '# Ship')
  writeFileSync(join(root, 'workflows', 'nightly.ts'), 'export default {}\n')
  return root
}

/** A directory of agent markdown files, with no manifest of any kind. */
function createAgentsDir(name: string, files: Record<string, string>): string {
  const root = join(dir, name)
  mkdirSync(root, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(root, file), content)
  }
  return root
}

function createGoodBundle(): string {
  const root = join(dir, 'good')
  mkdirSync(join(root, 'skills', 'review'), { recursive: true })
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'toolkit',
    name: 'Toolkit',
    version: '1.0.0',
    capabilities: [{
      kind: 'skill',
      id: 'review',
      skill: { slug: 'review', path: 'skills/review/SKILL.md' },
    }],
  }))
  writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '# Review')
  return root
}

function createBrokenBundle(): string {
  const root = join(dir, 'broken')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    name: 'Broken',
    version: '1.0.0',
    capabilities: 'not-an-array',
  }))
  return root
}

function createWarningOnlyBundle(): string {
  const root = join(dir, 'warning-only')
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  mkdirSync(join(root, 'skills', 'review'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'caption-less',
    version: '1.0.0',
    userConfig: { endpoint: { type: 'string' } },
  }))
  writeFileSync(
    join(root, 'skills', 'review', 'SKILL.md'),
    '---\nname: review\ndescription: Review code\n---\n\n# Review\n',
  )
  return root
}

/**
 * P6.420 — the mutating verbs.
 *
 * `uninstall`, `update` and `prune` run the PRODUCTION service against the
 * fixture store, so what is proven is the write. `install` and the `marketplace`
 * verbs take a stub registry: their production path clones a git repository, and
 * `forbidNetwork` is this suite's rule.
 */
function stubRegistry(
  overrides: Partial<MarketplaceRegistryApi> = {},
  calls: string[] = [],
): MarketplaceRegistryApi {
  return {
    add: async request => { calls.push(`add:${JSON.stringify(request)}`); return { marketplaceId: 'acme', displayName: 'Acme' } },
    remove: async request => { calls.push(`remove:${request.marketplaceId}`); return {} },
    list: async () => ({ registries: [
      { marketplaceId: 'acme', displayName: 'Acme', refName: 'v2', autoUpdate: true, autoUpdateManaged: true },
      { marketplaceId: 'local', displayName: 'Local', autoUpdate: false, autoUpdateManaged: false },
    ] }),
    upgrade: async request => { calls.push(`upgrade:${request.marketplaceId}`); return { upgraded: true } },
    refreshForInstall: async request => { calls.push(`refresh:${request.marketplaceId}`) },
    peekCachedItems: async () => [],
    ...overrides,
  }
}

describe('nessy-general-agent plugin marketplace', () => {
  it('add passes the source, ref, sparse paths and name through to the registry', async () => {
    const calls: string[] = []
    const result = await runPluginCommand(
      ['marketplace', 'add', 'acme-corp/plugins', '--ref', 'v2.0', '--sparse', '.claude-plugin, plugins', '--name', 'Acme'],
      { registry: () => stubRegistry({}, calls) },
    )
    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Added marketplace: Acme (acme)')
    expect(calls).toEqual([
      'add:{"source":"acme-corp/plugins","refName":"v2.0","sparsePaths":[".claude-plugin","plugins"],"displayName":"Acme"}',
    ])
  })

  it('list names which layer decided auto-update', async () => {
    const result = await runPluginCommand(['marketplace', 'list'], { registry: () => stubRegistry() })
    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('on (managed)')
    expect(result.text).toContain('off')
  })

  it('remove takes the id, under either spelling', async () => {
    for (const verb of ['remove', 'rm']) {
      const calls: string[] = []
      const result = await runPluginCommand(['marketplace', verb, 'acme'], {
        registry: () => stubRegistry({}, calls),
      })
      expect(result.exitCode, verb).toBe(0)
      expect(calls, verb).toEqual(['remove:acme'])
    }
  })

  // "Updates all marketplaces if omitted" — `plugin-marketplaces.md`
  // § *Plugin marketplace update*.
  it('update with no id upgrades every registered marketplace', async () => {
    const calls: string[] = []
    const result = await runPluginCommand(['marketplace', 'update'], {
      registry: () => stubRegistry({}, calls),
    })
    expect(result.exitCode).toBe(0)
    expect(calls).toEqual(['upgrade:acme', 'upgrade:local'])
    expect(result.text).toBe('acme: updated\nlocal: updated')
  })

  it('update with an id upgrades only that one', async () => {
    const calls: string[] = []
    await runPluginCommand(['marketplace', 'update', 'acme'], { registry: () => stubRegistry({}, calls) })
    expect(calls).toEqual(['upgrade:acme'])
  })

  it('an unknown marketplace verb prints its own usage and exits non-zero', async () => {
    const result = await runPluginCommand(['marketplace', 'sync'], { registry: () => stubRegistry() })
    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('Unknown marketplace verb: sync')
  })
})

describe('nessy-general-agent plugin install', () => {
  const item = {
    id: 'acme:inventory-kit',
    name: 'inventory-kit',
    marketplaceRegistryId: 'acme',
    install: { source: { type: 'npm' as const, packageName: '@acme/inventory-kit' } },
  }

  it('refreshes the named marketplace BEFORE the lookup, then installs', async () => {
    const calls: string[] = []
    const installs: unknown[] = []
    const result = await runPluginCommand(['install', 'inventory-kit@acme'], {
      registry: () => stubRegistry({ peekCachedItems: async () => [item] }, calls),
      management: () => ({
        install: async source => { installs.push(source); return { ok: true, installed: { pluginKey: 'acme__inventory-kit' } } },
        update: async () => ({}),
        uninstall: async () => ({}),
        configure: async () => ({}),
        pruneDependencies: async () => ({}),
      } as PluginMutationApi),
    })
    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Installed: inventory-kit@acme')
    // The refresh is first: `plugins/install.md#install-a-plugin`.
    expect(calls[0]).toBe('refresh:acme')
    expect(installs).toHaveLength(1)
  })

  it('names every marketplace offering the name rather than picking one', async () => {
    const result = await runPluginCommand(['install', 'inventory-kit'], {
      registry: () => stubRegistry({
        peekCachedItems: async () => [item, { ...item, id: 'other:inventory-kit', marketplaceRegistryId: 'other' }],
      }),
    })
    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('inventory-kit@acme, inventory-kit@other')
  })

  it('says where to look when the name is in no cached catalog', async () => {
    const result = await runPluginCommand(['install', 'nope'], { registry: () => stubRegistry() })
    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('plugin marketplace list')
  })

  it('writes --config through the service, and refuses without a workspace', async () => {
    const configured: unknown[] = []
    const management = () => ({
      install: async () => ({ ok: true, installed: { pluginKey: 'acme__inventory-kit' } }),
      update: async () => ({}),
      uninstall: async () => ({}),
      configure: async (key: string, workspaceId: string, values: Record<string, unknown>) => {
        configured.push({ key, workspaceId, values })
        return {}
      },
      pruneDependencies: async () => ({}),
    } as PluginMutationApi)

    const refused = await runPluginCommand(['install', 'inventory-kit@acme', '--config', 'apiUrl=https://x'], {
      registry: () => stubRegistry({ peekCachedItems: async () => [item] }),
      management,
    })
    expect(refused.exitCode).toBe(1)
    expect(refused.text).toContain('--config needs --workspace')
    expect(configured).toEqual([])

    const applied = await runPluginCommand(
      ['install', 'inventory-kit@acme', '--config', 'apiUrl=https://x', '--config', 'depth=3', '--workspace', 'ws-a'],
      { registry: () => stubRegistry({ peekCachedItems: async () => [item] }), management },
    )
    expect(applied.exitCode).toBe(0)
    expect(applied.text).toContain('Configured: apiUrl, depth')
    expect(configured).toEqual([
      { key: 'acme__inventory-kit', workspaceId: 'ws-a', values: { apiUrl: 'https://x', depth: '3' } },
    ])
  })

  it('refuses a malformed --config instead of writing half of it', async () => {
    const result = await runPluginCommand(['install', 'inventory-kit@acme', '--config', 'apiUrl', '--workspace', 'ws-a'], {
      registry: () => stubRegistry({ peekCachedItems: async () => [item] }),
    })
    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('--config takes key=value')
  })
})

describe('nessy-general-agent plugin uninstall / update / prune', () => {
  it('uninstall removes the plugin from the production store', async () => {
    const { rows, pluginKey, service } = await installFixtureAndCollect(createInventoryBundle())
    const result = await runPluginCommand(['uninstall', 'Inventory Kit'], {
      collect: async () => rows,
      management: () => service as unknown as PluginMutationApi,
    })
    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Uninstalled: Inventory Kit')
    const registry = await new PluginStoreV2({ rootDirectory: join(dir, 'plugins') }).readInstalledRegistry()
    expect(registry.plugins.map(entry => entry.pluginKey)).not.toContain(pluginKey)
  })

  it('uninstall honours the documented aliases and --keep-data', async () => {
    for (const verb of ['remove', 'rm']) {
      const { rows, service } = await installFixtureAndCollect(createInventoryBundle())
      const result = await runPluginCommand([verb, 'Inventory Kit', '--keep-data'], {
        collect: async () => rows,
        management: () => service as unknown as PluginMutationApi,
      })
      expect(result.exitCode, verb).toBe(0)
      expect(result.text, verb).toContain('data directory preserved')
    }
  })

  it('uninstall --prune runs the prune AFTER the uninstall', async () => {
    const order: string[] = []
    const { rows } = await installFixtureAndCollect(createInventoryBundle())
    const result = await runPluginCommand(['uninstall', 'Inventory Kit', '--prune'], {
      collect: async () => rows,
      management: () => ({
        install: async () => ({}),
        update: async () => ({}),
        uninstall: async () => { order.push('uninstall'); return {} },
        configure: async () => ({}),
        pruneDependencies: async () => { order.push('prune'); return { removed: [] } },
      } as PluginMutationApi),
    })
    expect(result.exitCode).toBe(0)
    expect(order).toEqual(['uninstall', 'prune'])
  })

  it('update reinstalls through the production service', async () => {
    const { rows, service } = await installFixtureAndCollect(createInventoryBundle())
    const result = await runPluginCommand(['update', 'Inventory Kit'], {
      collect: async () => rows,
      management: () => service as unknown as PluginMutationApi,
    })
    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Updated: Inventory Kit')
  })

  it('prune --dry-run says what it WOULD remove', async () => {
    const result = await runPluginCommand(['prune', '--dry-run'], {
      management: () => ({
        install: async () => ({}),
        update: async () => ({}),
        uninstall: async () => ({}),
        configure: async () => ({}),
        pruneDependencies: async options => {
          expect(options).toEqual({ dryRun: true })
          return { removed: [{ pluginKey: 'acme__dep' }] }
        },
      } as PluginMutationApi),
    })
    expect(result.exitCode).toBe(0)
    expect(result.text).toBe('Would prune 1: acme__dep')
  })

  it('a name that is not installed is refused for every mutating verb', async () => {
    for (const verb of ['uninstall', 'update']) {
      const result = await runPluginCommand([verb, 'ghost'], { collect: async () => [] })
      expect(result.exitCode, verb).toBe(1)
      expect(result.text, verb).toBe('No installed plugin named: ghost')
    }
  })
})

describe('the usage text names every dispatched verb', () => {
  // The trap this closes: a verb added to the switch and not to USAGE is
  // undiscoverable, which is the same defect P6.559 fixed from the other side
  // (a remedy naming a verb the switch did not have).
  it('lists each one', async () => {
    const usage = (await runPluginCommand([])).text
    for (const verb of [
      'validate', 'list', 'details', 'disable',
      'install', 'uninstall', 'update', 'prune', 'marketplace',
    ]) {
      expect(usage, verb).toContain(verb)
    }
  })
})

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { createInstallTracker } from '@nessy-agent/shared/testing/install-tracker'
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS)
const installs = createInstallTracker()
