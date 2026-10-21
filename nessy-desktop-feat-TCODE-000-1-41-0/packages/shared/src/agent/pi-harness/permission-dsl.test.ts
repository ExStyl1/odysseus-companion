import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  compilePermissionDslV1,
  evaluatePermissionDslV1,
  filterCapabilityIdentitiesByWholeToolDeny,
  isWholeCapabilityDeniedByPermissionDsl,
  parsePermissionDslV1,
  parsePermissionJsonc, permissionDslDenyReason, // F1.863 — on one line: every cited line keeps its place
  rawDslInputPath,
  type PermissionDslLayerInputV1,
} from './permission-dsl.ts'
import { parseClaudeRuleString } from './claude-permission-rules.ts'
import { canonicalizeForDecision } from '../session-filesystem-scope.ts'

const layer = (
  scope: PermissionDslLayerInputV1['scope'],
  rules: unknown[],
  overrides: Partial<PermissionDslLayerInputV1> = {},
): PermissionDslLayerInputV1 => ({
  scope,
  sourceDigest: `${scope}-digest`,
  document: { version: 1, rules },
  ...overrides,
})

const request = (overrides: Partial<Parameters<typeof evaluatePermissionDslV1>[1]> = {}) => ({
  generation: 'generation-1',
  semanticId: 'bash',
  toolName: 'Bash',
  input: { command: 'git status' },
  cwd: '/workspace',
  ...overrides,
})

describe('Nessy permission DSL v1', () => {
  test('parses the immutable managed document strictly and keeps its deny terminal', () => {
    const managed = parsePermissionDslV1({
      version: 1,
      rules: [{ id: 'host-deny-bash', action: 'deny', match: { kind: 'tool', semanticId: 'bash' } }],
    })
    const program = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: true,
      layers: [
        { scope: 'managed', sourceDigest: 'host-policy', document: { ...managed, generation: 'generation-1' } },
        layer('project', [{ id: 'project-allow-bash', action: 'allow', match: { kind: 'tool', semanticId: 'bash' } }]),
      ],
    })
    expect(evaluatePermissionDslV1(program, request())).toMatchObject({
      action: 'deny', match: { ruleId: 'host-deny-bash', scope: 'managed' },
    })
    expect(() => parsePermissionDslV1({ ...managed, generation: 'persisted' })).toThrow()
    expect(() => parsePermissionDslV1({ version: 1, rules: [{ id: 'x', action: 'deny', match: { kind: 'unknown' } }] })).toThrow()
  })

  test('parses JSONC and enforces monotonic precedence', () => {
    expect(parsePermissionJsonc(`{
      // readable policy
      "version": 1,
      "label": "literal,}",
      "rules": [{ "id": "read", "action": "allow", "match": { "kind": "tool", "semanticId": "read" } }],
    }`)).toMatchObject({ version: 1, label: 'literal,}' })

    const trusted = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: true,
      layers: [
        layer('global', [{ id: 'upper-ask', action: 'ask', match: { kind: 'tool', semanticId: 'bash' } }]),
        layer('project', [{ id: 'narrow-deny', action: 'deny', match: { kind: 'tool', semanticId: 'bash' } }]),
      ],
    })
    expect(evaluatePermissionDslV1(trusted, request()).action).toBe('deny')
  })

  /**
   * P6.193 — this PIN IS FLIPPED, not added.
   *
   * The case above used to be named "…while ignoring untrusted project rules"
   * and asserted that an untrusted project's `deny` rule was ignored, which is
   * what the compiler did: `if (layer.scope === 'project' && !projectTrusted)
   * continue` dropped the whole layer. Opening an untrusted repository
   * therefore DELETED its restrictions in the name of caution — a loosening
   * performed by a trust boundary.
   *
   * The contract now: an untrusted project may RESTRICT and may not GRANT, and
   * the page says exactly that of the trust boundary itself.
   * `permissions.md#project-allow-rules-and-workspace-trust` — "`permissions.allow`
   * rules and `permissions.additionalDirectories` entries in a project's
   * `.claude/settings.json` grant capability, so Claude Code applies them only
   * after you accept the workspace trust dialog for that folder", and "`deny` and
   * `ask` rules aren't affected, since they only restrict."
   * `permissions.md#manage-permissions` carries the ordering the compiler
   * implements: "Rules are evaluated in order: deny, then ask, then allow. The
   * first match in that order determines the outcome, and rule specificity
   * doesn't change the order."
   *
   * Re-anchored P6.661. The former cite was `#permission-rules`, which is not a
   * section of the page (it publishes `#permission-rule-syntax`), and its quoted
   * words — a `deny` rule "is applied first and cannot be overridden" — are on
   * no fetchable revision of it: a phantom quote standing in for a contract the
   * page states plainly two sections away.
   */
  test('an untrusted project keeps its deny and ask rules and loses only its allow rules (P6.193)', () => {
    const layers = () => [
      layer('global', [{ id: 'upper-ask', action: 'ask', match: { kind: 'tool', semanticId: 'bash' } }]),
      layer('project', [
        { id: 'project-deny', action: 'deny', match: { kind: 'tool', semanticId: 'write' } },
        { id: 'project-ask', action: 'ask', match: { kind: 'tool', semanticId: 'read' } },
        // A tool NO other layer governs, so the grant's presence or absence is
        // the only thing that can decide the outcome. (A `bash` allow here
        // would be answered by the global `ask` in BOTH arms — monotonic
        // precedence — and the control would prove nothing.)
        { id: 'project-allow', action: 'allow', match: { kind: 'tool', semanticId: 'fetch' } },
      ]),
    ]
    const fetchRequest = { semanticId: 'fetch', toolName: 'WebFetch', input: { url: 'https://example.com/x' } }

    const untrusted = compilePermissionDslV1({ generation: 'generation-1', projectTrusted: false, layers: layers() })

    // The RESTRICTIONS apply. This is the assertion the old pin had inverted.
    expect(evaluatePermissionDslV1(untrusted, request({ semanticId: 'write', toolName: 'Write', input: { file_path: 'a' } }))).toEqual({
      action: 'deny',
      match: { ruleId: 'project-deny', scope: 'project', sourceDigest: 'project-digest' },
    })
    expect(evaluatePermissionDslV1(untrusted, request({ semanticId: 'read', toolName: 'Read', input: { file_path: 'a' } })).action).toBe('ask')

    // The GRANT does not: no rule answers, so the call falls through to the
    // gate's own mode rather than being cleared by the folder.
    expect(evaluatePermissionDslV1(untrusted, request(fetchRequest)).action).toBeUndefined()
    // …and the layer above is untouched.
    expect(evaluatePermissionDslV1(untrusted, request()).action).toBe('ask')

    // The withheld grant is RECORDED, with a sentence the user can act on —
    // never a silent subtraction.
    expect(untrusted.droppedRules.map(rule => rule.id)).toEqual(['project-allow'])
    const withheld = untrusted.diagnostics.filter(d => d.code === 'project-untrusted')
    expect(withheld).toHaveLength(1)
    expect(withheld[0]!.message).toContain('project-allow')
    expect(withheld[0]!.message).toContain('deny and ask rules DO apply')
    // And it never restates the two rules it kept: only the grant is dropped.
    expect(untrusted.rules.map(rule => rule.id)).toEqual(['upper-ask', 'project-deny', 'project-ask'])

    // CONTROL — trusting the folder applies the allow and drops the diagnostic,
    // so the negatives above are not passing over a compiler that dropped
    // everything.
    const trusted = compilePermissionDslV1({ generation: 'generation-1', projectTrusted: true, layers: layers() })
    expect(evaluatePermissionDslV1(trusted, request(fetchRequest))).toEqual({
      action: 'allow',
      match: { ruleId: 'project-allow', scope: 'project', sourceDigest: 'project-digest' },
    })
    expect(trusted.droppedRules).toEqual([])
    expect(trusted.diagnostics.filter(d => d.code === 'project-untrusted')).toEqual([])
  })

  /**
   * P6.191 — auto mode's DEFAULT-ON suspension of broad shell grants.
   *
   * `auto-mode-config.md#route-all-shell-commands-through-the-classifier`:
   * "Claude Code suspends only the broad rules that grant arbitrary code
   * execution, such as `Bash(*)` or wildcarded interpreters, together with every
   * rule that names `Monitor`, because Monitor commands run through the shell."
   * The complement matters as much: "narrow Bash and PowerShell allow rules such
   * as `Bash(npm test)` stay in effect in auto mode".
   */
  describe('auto mode suspends broad shell grants and keeps narrow ones (P6.191)', () => {
    const compile = (rules: unknown[]) => compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: true,
      layers: [layer('workspace', rules)],
    })

    test('`Bash(*)` grants nothing while the suspension is on, and the SAME program grants again with it off', () => {
      const program = compile([
        { id: 'broad', action: 'allow', match: { kind: 'bash', pattern: '*' }, text: 'Bash(*)' },
      ])
      // The rule is compiled and present — "leaving auto mode restores the rule
      // verbatim" is true by construction, not by re-compiling.
      expect(program.rules.map(rule => rule.id)).toEqual(['broad'])

      const suspended = evaluatePermissionDslV1(program, request({ suspendBroadShellGrants: true }))
      expect(suspended.action).toBeUndefined()

      const restored = evaluatePermissionDslV1(program, request())
      expect(restored.action).toBe('allow')
      expect(restored.match?.ruleId).toBe('broad')
    })

    test('a narrow rule keeps working, which is the half the page states first', () => {
      const program = compile([
        { id: 'narrow', action: 'allow', match: { kind: 'bash', pattern: 'npm test' }, text: 'Bash(npm test)' },
      ])
      expect(evaluatePermissionDslV1(program, request({
        input: { command: 'npm test' },
        suspendBroadShellGrants: true,
      })).action).toBe('allow')
    })

    test('a wildcarded interpreter is broad; a wildcarded non-interpreter is not', () => {
      const broad = compile([{ id: 'py', action: 'allow', match: { kind: 'bash', pattern: 'python *' } }])
      expect(broad.rules[0]!.broadShellGrant).toBe(true)
      // `Bash(npm *)` is the page's own narrow-rule-with-a-wildcard case: it
      // "can still let a destructive argument through", and that residual risk
      // is the stated cost of the default rather than something to fix here.
      const narrow = compile([{ id: 'npm', action: 'allow', match: { kind: 'bash', pattern: 'npm *' } }])
      expect(narrow.rules[0]!.broadShellGrant).toBeUndefined()
    })

    test('a bare Bash, PowerShell or Monitor allow rule is broad; Agent is NOT', () => {
      for (const semanticId of ['Bash', 'PowerShell', 'Monitor']) {
        const program = compile([{ id: semanticId, action: 'allow', match: { kind: 'tool', semanticId } }])
        expect(program.rules[0]!.broadShellGrant, semanticId).toBe(true)
      }
      // The row asking for this named `Agent` as a third class. The page does
      // not: it scopes the suspension to shell. Suspending an Agent allow rule
      // would be a protection this fork invented against a rule a page told the
      // user would hold.
      const agent = compile([{ id: 'agent', action: 'allow', match: { kind: 'tool', semanticId: 'Agent' } }])
      expect(agent.rules[0]!.broadShellGrant).toBeUndefined()
    })

    test('no RESTRICTION is lifted — a deny or ask rule is never marked', () => {
      const program = compile([
        { id: 'deny-all', action: 'deny', match: { kind: 'bash', pattern: '*' } },
        { id: 'ask-all', action: 'ask', match: { kind: 'tool', semanticId: 'Monitor' } },
      ])
      expect(program.rules.every(rule => rule.broadShellGrant === undefined)).toBe(true)
      expect(evaluatePermissionDslV1(program, request({ suspendBroadShellGrants: true })).action).toBe('deny')
    })

    test('a suspended broad grant does not shadow a co-resident narrow one', () => {
      // First-match ordering with the broad rule FIRST: skipping it has to let
      // the narrow rule below answer, not end the search.
      const program = compile([
        { id: 'broad', action: 'allow', match: { kind: 'bash', pattern: '*' } },
        { id: 'narrow', action: 'allow', match: { kind: 'bash', pattern: 'npm test' } },
      ])
      const result = evaluatePermissionDslV1(program, request({
        input: { command: 'npm test' },
        suspendBroadShellGrants: true,
      }))
      expect(result.action).toBe('allow')
      expect(result.match?.ruleId).toBe('narrow')
    })
  })

  test('an untrusted project whose document does not parse is still skipped whole (P6.193)', () => {
    // An unreadable document has no deny rules to salvage either, and salvaging
    // what a broken file happens to parse would enforce a policy nobody wrote.
    const program = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      layers: [
        layer('global', [{ id: 'upper-ask', action: 'ask', match: { kind: 'tool', semanticId: 'bash' } }]),
        layer('project', [], { diagnostic: { code: 'invalid-jsonc', message: 'Permission DSL is not valid JSONC.' } }),
      ],
    })
    expect(program.invalidSource).toBeUndefined()
    expect(program.diagnostics).toEqual([])
    expect(evaluatePermissionDslV1(program, request()).action).toBe('ask')
  })

  test('matches structurally parsed shell commands and never approves compound, substitution or glob syntax', () => {
    const program = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      canonicalizeRoot: canonicalizeForDecision,
      layers: [layer('workspace', [{
        id: 'git-status', action: 'allow',
        match: { kind: 'bash', executable: 'git', args: ['status'], cwdRoot: '/workspace' },
      }])],
    })
    expect(evaluatePermissionDslV1(program, request({ input: { command: 'env CI=1 command git status' } })).action).toBe('allow')
    for (const command of ['git status && rm -rf x', 'echo $(whoami)', 'cat *.pem']) {
      const result = evaluatePermissionDslV1(program, request({ input: { command } }))
      expect(result.action, command).toBeUndefined() // F1.784 — an ALLOW neither approves nor refuses what it cannot read
      expect(JSON.stringify(result), command).not.toContain(command)
    }
  })

  test('matches canonical path, host, MCP, agent and selected safe parameters without exposing values', () => {
    const program = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      canonicalizeRoot: canonicalizeForDecision,
      layers: [layer('workspace', [
        { id: 'path', action: 'allow', match: { kind: 'path', root: '/workspace' } },
        { id: 'host', action: 'ask', match: { kind: 'host', host: '*.example.com' } },
        { id: 'mcp', action: 'deny', match: { kind: 'mcp', server: 'gitlab', tool: 'delete_*' } },
        { id: 'agent', action: 'ask', match: { kind: 'agent', agent: 'reviewer' } },
        { id: 'agent-key', action: 'ask', match: { kind: 'agent', agent: 'plugin:agent:reviewer' } },
        { id: 'method', action: 'deny', match: { kind: 'parameter', name: 'method', equals: 'DELETE' } },
      ])],
    })
    expect(evaluatePermissionDslV1(program, request({
      semanticId: 'write', toolName: 'Write', input: { file_path: 'src/a.ts' },
      canonicalizePath: value => value === 'src/a.ts' ? '/outside/a.ts' : value,
    })).action).toBeUndefined()
    expect(evaluatePermissionDslV1(program, request({ semanticId: 'fetch', toolName: 'WebFetch', input: { url: 'https://api.example.com/x' } })).action).toBe('ask')
    expect(evaluatePermissionDslV1(program, request({ semanticId: 'mcp.gitlab.delete_project', toolName: 'mcp__gitlab__delete_project', input: {} })).action).toBe('deny')
    expect(evaluatePermissionDslV1(program, request({ semanticId: 'spawn_session', toolName: 'spawn_session', input: { agent: 'reviewer' } })).action).toBeUndefined()
    expect(evaluatePermissionDslV1(program, request({ semanticId: 'agent-admission', toolName: 'subagent', input: { agent: 'reviewer', agent_key: 'builtin:reviewer' } })).action).toBe('ask')
    expect(evaluatePermissionDslV1(program, request({ semanticId: 'agent-admission', toolName: 'subagent', input: { agent: 'plugin-reviewer', agent_key: 'plugin:agent:reviewer' } })).action).toBe('ask')
    expect(evaluatePermissionDslV1(program, request({ semanticId: 'api', toolName: 'api_gitlab', input: { method: 'DELETE', token: 'secret' } }))).toMatchObject({
      action: 'deny', match: { ruleId: 'method', sourceDigest: 'workspace-digest' },
    })
  })

  // F1.831 (owner option A, 2026-09-26) — per-DOCUMENT isolation, as
  // `managed-settings.md#keys-that-fail-closed` states it: "a file whose JSON or
  // top-level shape fails validation is rejected as a whole and reported". Only
  // a broken MANAGED document still fails everything closed.
  test('F1.831 — a broken non-managed document is dropped whole and the other documents keep applying', () => {
    const managedDeny = layer('managed', [{ id: 'managed-no-rm', action: 'deny', match: { kind: 'bash', executable: 'rm' } }])
    const rm = request({ input: { command: 'rm -rf x' } })
    for (const broken of [
      layer('workspace', [], { document: undefined, diagnostic: { code: 'invalid-jsonc', message: 'Permission DSL JSONC is invalid.' } }),
      layer('project', [{ id: 'own-deny', action: 'deny', match: { kind: 'bash', executable: 'git' } }, { id: 'x', action: 'allow', match: { kind: 'substring', value: 'rm' } }]),
      layer('plugin', [], { document: { version: 1, generation: 'old', rules: [] } }),
      layer('global', [], { document: 'not a document' }),
    ]) {
      const program = compilePermissionDslV1({ generation: 'generation-1', projectTrusted: true, layers: [managedDeny, broken] })
      expect(program.invalidSource).toBeUndefined()
      expect(program.rules.map(rule => rule.id)).toEqual(['managed-no-rm'])
      expect(program.droppedSources?.map(source => source.scope)).toEqual([broken.scope])
      expect(program.diagnostics).toHaveLength(1)
      expect(program.diagnostics[0]!.message).toContain(`The ${broken.scope} permission settings document was ignored as a whole`)
      expect(evaluatePermissionDslV1(program, rm)).toMatchObject({ action: 'deny', match: { ruleId: 'managed-no-rm', scope: 'managed' } })
      // Its own rules went with it (`own-deny` compiled before the bad rule), and a
      // call nothing names is no longer refused — it carries the announcement only.
      const unnamed = evaluatePermissionDslV1(program, request())
      expect(unnamed.action).toBeUndefined()
      expect(unnamed.match).toMatchObject({ ruleId: 'invalid-policy', scope: broken.scope })
    }
  })

  test('F1.831 — a broken MANAGED document and a stale request still fail closed', () => {
    const invalid = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      layers: [layer('managed', [{ id: 'x', action: 'allow', match: { kind: 'substring', value: 'rm' } }]), layer('workspace', [])],
    })
    expect(invalid.droppedSources).toBeUndefined()
    expect(evaluatePermissionDslV1(invalid, request())).toMatchObject({ action: 'deny', match: { ruleId: 'invalid-policy', scope: 'managed' } })
    expect(evaluatePermissionDslV1(compilePermissionDslV1({ generation: 'generation-1', projectTrusted: false, layers: [] }), request({ generation: 'generation-2' }))).toMatchObject({ action: 'deny' })
  })

  test('rejects relative roots and canonicalizes symlink roots before deny matching', () => {
    const relativeRoot = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      canonicalizeRoot: canonicalizeForDecision,
      layers: [layer('workspace', [{ id: 'relative', action: 'deny', match: { kind: 'path', root: '.' } }])],
    })
    // P2.270 — a rule whose specifier will not compile is SKIPPED, whatever its
    // action (`managed-settings.md#keys-that-fail-closed`: "an individual entry
    // that fails, such as a malformed permission rule, is skipped with a
    // warning while the rest of the file applies"). So a relative `root` is
    // still rejected — it must never be resolved against the request cwd and
    // deny on that basis — but the rejection costs the rule, not the policy.
    expect(relativeRoot.rules).toHaveLength(0)
    expect(relativeRoot.droppedRules.map(rule => rule.id)).toEqual(['relative'])
    expect(relativeRoot.invalidSource).toBeUndefined()
    const relativeVerdict = evaluatePermissionDslV1(relativeRoot, request({
      semanticId: 'write', toolName: 'Write', input: { file_path: '/workspace/a.ts' },
      canonicalizePath: canonicalizeForDecision,
    }))
    expect(relativeVerdict.action).toBeUndefined()
    expect(relativeVerdict.match).toMatchObject({ ruleId: 'invalid-policy' })

    const root = mkdtempSync(join(tmpdir(), 'nessy-permission-root-'))
    try {
      const actual = join(root, 'actual')
      const linked = join(root, 'linked')
      mkdirSync(actual)
      symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir')
      const canonicalActual = realpathSync(actual)
      const pathProgram = compilePermissionDslV1({
        generation: 'generation-1',
        projectTrusted: false,
        canonicalizeRoot: canonicalizeForDecision,
        layers: [layer('workspace', [{ id: 'symlink-path', action: 'deny', match: { kind: 'path', root: linked } }])],
      })
      expect(evaluatePermissionDslV1(pathProgram, request({
        semanticId: 'write', toolName: 'Write', input: { file_path: join(canonicalActual, 'a.ts') },
        canonicalizePath: canonicalizeForDecision,
      }))).toMatchObject({ action: 'deny', match: { ruleId: 'symlink-path' } })

      const bashProgram = compilePermissionDslV1({
        generation: 'generation-1',
        projectTrusted: false,
        canonicalizeRoot: canonicalizeForDecision,
        layers: [layer('workspace', [{
          id: 'symlink-cwd', action: 'deny', match: { kind: 'bash', executable: 'git', args: ['status'], cwdRoot: linked },
        }])],
      })
      expect(evaluatePermissionDslV1(bashProgram, request({ cwd: canonicalActual })))
        .toMatchObject({ action: 'deny', match: { ruleId: 'symlink-cwd' } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('pathGlob: allow anchors to cwd, deny floats single-segment patterns, strict parse', () => {
    const resolvePath = (value: string, cwd: string) => resolve(cwd, value)
    const program = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      canonicalizeRoot: canonicalizeForDecision,
      layers: [layer('workspace', [
        { id: 'allow-src', action: 'allow', match: { kind: 'pathGlob', pattern: 'src/**', anchor: 'relative' } },
        { id: 'deny-secrets', action: 'deny', match: { kind: 'pathGlob', pattern: 'secrets/**', anchor: 'relative' } },
        { id: 'deny-components', action: 'deny', match: { kind: 'pathGlob', pattern: 'src/components/**', anchor: 'relative' } },
        { id: 'deny-abs', action: 'deny', match: { kind: 'pathGlob', pattern: 'etc/vault/**', anchor: 'absolute' } },
      ])],
    })
    const edit = (file_path: string, extra: Record<string, unknown> = {}) => request({
      semanticId: 'edit', toolName: 'Edit', input: { file_path },
      canonicalizePath: resolvePath,
      ...extra,
    })
    // Allow: matches only <cwd>/src/** (permissions.md allow depth).
    expect(evaluatePermissionDslV1(program, edit('src/a.ts')).action).toBe('allow')
    expect(evaluatePermissionDslV1(program, edit('lib/src/a.ts')).action).toBeUndefined()
    // Deny: a single-segment directory pattern matches at ANY depth...
    expect(evaluatePermissionDslV1(program, edit('x/secrets/k.pem'))).toMatchObject({
      action: 'deny', match: { ruleId: 'deny-secrets' },
    })
    // ...but a multi-segment pattern stays anchored in every rule type.
    expect(evaluatePermissionDslV1(program, edit('vendor/src/components/x.ts')).action).toBeUndefined()
    expect(evaluatePermissionDslV1(program, edit('src/components/x.ts')).action).toBe('deny')
    // Absolute anchor: matches from the filesystem root only.
    expect(evaluatePermissionDslV1(program, edit('/etc/vault/key'))).toMatchObject({
      action: 'deny', match: { ruleId: 'deny-abs' },
    })
    expect(evaluatePermissionDslV1(program, edit('/srv/etc/vault/key')).action).toBeUndefined()

    // Strict raw parse: the new kind is accepted, unknown fields throw.
    expect(() => parsePermissionDslV1({
      version: 1,
      rules: [{ id: 'ok', action: 'deny', match: { kind: 'pathGlob', pattern: 'a/**', anchor: 'relative' } }],
    })).not.toThrow()
    expect(() => parsePermissionDslV1({
      version: 1,
      rules: [{ id: 'bad', action: 'deny', match: { kind: 'pathGlob', pattern: 'a/**', anchor: 'relative', extra: true } }],
    })).toThrow()
    expect(() => parsePermissionDslV1({
      version: 1,
      rules: [{ id: 'bad-anchor', action: 'deny', match: { kind: 'pathGlob', pattern: 'a/**', anchor: 'everywhere' } }],
    })).toThrow()
  })

  test('pathGlob: symlink pair asymmetry and the source anchor', () => {
    const layerRules = (rules: unknown[], overrides: Partial<PermissionDslLayerInputV1> = {}) =>
      compilePermissionDslV1({
        generation: 'generation-1',
        projectTrusted: false,
        canonicalizeRoot: canonicalizeForDecision,
        layers: [layer('workspace', rules, overrides)],
      })
    // Allow requires the symlink path AND its resolved target to match: a link
    // inside src/ pointing outside never auto-allows.
    const allowProgram = layerRules([
      { id: 'allow-src', action: 'allow', match: { kind: 'pathGlob', pattern: 'src/**', anchor: 'relative' } },
    ])
    const linkAware = (value: string, cwd: string) => {
      const absolute = resolve(cwd, value)
      return absolute === '/workspace/src/link.ts' ? '/outside/real.ts' : absolute
    }
    expect(evaluatePermissionDslV1(allowProgram, request({
      semanticId: 'edit', toolName: 'Edit', input: { file_path: 'src/link.ts' }, canonicalizePath: linkAware,
    })).action).toBeUndefined()
    expect(evaluatePermissionDslV1(allowProgram, request({
      semanticId: 'edit', toolName: 'Edit', input: { file_path: 'src/plain.ts' }, canonicalizePath: linkAware,
    })).action).toBe('allow')
    // Deny matches when EITHER side matches — here only the resolved target.
    const denyProgram = layerRules([
      { id: 'deny-secret', action: 'deny', match: { kind: 'pathGlob', pattern: 'secret/**', anchor: 'relative' } },
    ])
    const intoSecret = (value: string, cwd: string) => {
      const absolute = resolve(cwd, value)
      return absolute === '/workspace/ok/link' ? '/workspace/secret/key' : absolute
    }
    expect(evaluatePermissionDslV1(denyProgram, request({
      semanticId: 'read', toolName: 'Read', input: { file_path: 'ok/link' }, canonicalizePath: intoSecret,
    })).action).toBe('deny')
    // rawInputPath threads the pre-canonicalization value: a host that passes
    // canonicalized input still lets deny match the symlink path itself.
    expect(evaluatePermissionDslV1(denyProgram, request({
      semanticId: 'read', toolName: 'Read', input: { file_path: '/outside/real.ts' },
      canonicalizePath: (value, cwd) => resolve(cwd, value),
      rawInputPath: 'secret/link',
    })).action).toBe('deny')

    // Source anchor resolves against the layer's sourceRoot...
    const sourced = layerRules([
      { id: 'deny-cfg', action: 'deny', match: { kind: 'pathGlob', pattern: 'cfg/**', anchor: 'source' } },
    ], { sourceRoot: '/policy/root' })
    expect(evaluatePermissionDslV1(sourced, request({
      semanticId: 'read', toolName: 'Read', input: { file_path: '/policy/root/cfg/x' },
      canonicalizePath: value => value,
    })).action).toBe('deny')
    // ...and a source-anchored rule without one is SKIPPED (P2.270): the anchor
    // is exactly what could not be resolved, so the rule cannot be enforced,
    // but it costs the rule rather than the layer. What must never happen is
    // the anchor silently falling back to the cwd or the filesystem root and
    // denying on a directory the author never named.
    const unrooted = layerRules([
      { id: 'deny-cfg', action: 'deny', match: { kind: 'pathGlob', pattern: 'cfg/**', anchor: 'source' } },
    ])
    expect(unrooted.rules).toHaveLength(0)
    expect(unrooted.droppedRules.map(rule => rule.id)).toEqual(['deny-cfg'])
    expect(unrooted.invalidSource).toBeUndefined()
    const unrootedVerdict = evaluatePermissionDslV1(unrooted, request({
      semanticId: 'read', toolName: 'Read', input: { file_path: '/policy/root/cfg/x' },
      canonicalizePath: value => value,
    }))
    expect(unrootedVerdict.action).toBeUndefined()
    expect(unrootedVerdict.match).toMatchObject({ ruleId: 'invalid-policy' })
  })

  test('bash pattern, host wildcard and parameter matches extensions for Claude rules', () => {
    const program = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      canonicalizeRoot: canonicalizeForDecision,
      layers: [layer('workspace', [
        { id: 'allow-git', action: 'allow', match: { kind: 'bash', pattern: 'git *' } },
        { id: 'deny-rm', action: 'deny', match: { kind: 'bash', pattern: 'rm -rf *' } },
        { id: 'host-tld', action: 'ask', match: { kind: 'host', host: 'example.*' } },
        { id: 'deny-isolation', action: 'deny', match: { kind: 'parameter', name: 'isolation', matches: '*' } },
      ])],
    })
    // Allow requires EVERY subcommand to match; wrappers strip.
    expect(evaluatePermissionDslV1(program, request({ input: { command: 'timeout 5 git status' } })).action).toBe('allow')
    expect(evaluatePermissionDslV1(program, request({ input: { command: 'git status && rm -rf /tmp/x' } }))).toMatchObject({
      action: 'deny', match: { ruleId: 'deny-rm' },
    })
    // permissions.md:210 — an unparseable command PROMPTS; it is never turned
    // into a terminal deny by an unrelated Bash rule.
    expect(evaluatePermissionDslV1(program, request({ input: { command: 'git "status' } })).action).toBe('ask')
    // Between-dots host wildcard never crosses a dot.
    expect(evaluatePermissionDslV1(program, request({
      semanticId: 'fetch', toolName: 'WebFetch', input: { url: 'https://example.org/x' },
    })).action).toBe('ask')
    expect(evaluatePermissionDslV1(program, request({
      semanticId: 'fetch', toolName: 'WebFetch', input: { url: 'https://example.evil.com/x' },
    })).action).toBeUndefined()
    // Deny parameter glob matches any explicit value; an omitted parameter
    // never matches.
    expect(evaluatePermissionDslV1(program, request({
      semanticId: 'agent-spawn', toolName: 'Agent', input: { isolation: 'worktree' },
    })).action).toBe('deny')
    expect(evaluatePermissionDslV1(program, request({
      semanticId: 'agent-spawn', toolName: 'Agent', input: {},
    })).action).toBeUndefined()

    // Strict parse: pattern excludes the structural fields; allow rules keep
    // the curated parameter vocabulary while deny accepts any scalar field.
    expect(() => parsePermissionDslV1({
      version: 1,
      rules: [{ id: 'bad', action: 'allow', match: { kind: 'bash', pattern: 'git *', executable: 'git' } }],
    })).toThrow()
    expect(() => parsePermissionDslV1({
      version: 1,
      rules: [{ id: 'bad-allow', action: 'allow', match: { kind: 'parameter', name: 'isolation', matches: '*' } }],
    })).toThrow()
    expect(() => parsePermissionDslV1({
      version: 1,
      rules: [{ id: 'ok-deny', action: 'deny', match: { kind: 'parameter', name: 'isolation', matches: '*' } }],
    })).not.toThrow()
    expect(() => parsePermissionDslV1({
      version: 1,
      rules: [{ id: 'two-forms', action: 'deny', match: { kind: 'parameter', name: 'isolation', equals: 'x', matches: '*' } }],
    })).toThrow()
  })

  test('a parameter rule string meets the literal value the input carries, whatever its JSON type', () => {
    // permissions.md § Match by input parameter gives `Bash(run_in_background:true)`
    // and sandboxing.md:135 gives `Bash(dangerouslyDisableSandbox:true)` as ask
    // rules. A rule STRING can only carry text, so both compile to
    // `equals: 'true'` — under strict `===` neither could ever fire on the
    // boolean the tool input actually carries.
    const program = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      layers: [layer('workspace', [
        { id: 'ask-unsandboxed', action: 'ask', match: { kind: 'parameter', name: 'dangerouslyDisableSandbox', equals: 'true' } },
        { id: 'deny-slow', action: 'deny', match: { kind: 'parameter', name: 'timeout', equals: '600000' } },
        { id: 'deny-typed', action: 'deny', match: { kind: 'parameter', name: 'strict', equals: true } },
      ])],
    })
    const evaluate = (input: Record<string, unknown>) =>
      evaluatePermissionDslV1(program, request({ input })).action

    expect(evaluate({ command: 'x', dangerouslyDisableSandbox: true })).toBe('ask')
    expect(evaluate({ command: 'x', dangerouslyDisableSandbox: 'true' })).toBe('ask')
    expect(evaluate({ command: 'x', timeout: 600_000 })).toBe('deny')
    // Exactness is unchanged: a different value, a false, and an omitted
    // parameter all stay unmatched (permissions.md — "Without `*` the match is
    // exact"; "A parameter the model omits is never matched").
    expect(evaluate({ command: 'x', dangerouslyDisableSandbox: false })).toBeUndefined()
    expect(evaluate({ command: 'x', timeout: 60_000 })).toBeUndefined()
    expect(evaluate({ command: 'x' })).toBeUndefined()
    // A non-scalar never coerces into a match.
    expect(evaluate({ command: 'x', dangerouslyDisableSandbox: ['true'] })).toBeUndefined()
    // A native document's TYPED equals keeps strict equality.
    expect(evaluate({ command: 'x', strict: true })).toBe('deny')
    expect(evaluate({ command: 'x', strict: 'true' })).toBeUndefined()
  })

  test('an unparseable or over-long Bash command prompts, and never becomes an allow', () => {
    // permissions.md:210: "when Claude Code can't fully parse a command, it asks
    // for approval instead of treating the command as read-only. Commands
    // longer than 10,000 characters always prompt because they exceed what the
    // analysis parses." The carve-out is NOT allow-specific: before this, one
    // `Bash(rm *)` DENY rule turned an unrelated unparseable command into a
    // terminal deny exactly as an allow rule did.
    const withRules = (rules: unknown[]) => compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      canonicalizeRoot: canonicalizeForDecision,
      layers: rules.length > 0 ? [layer('workspace', rules)] : [],
    })
    const unparseable = 'echo "unbalanced'
    const overLong = `echo ${'a'.repeat(10_001)}`

    // No rules at all: the DSL abstains and the gate prompts on its own.
    expect(evaluatePermissionDslV1(withRules([]), request({ input: { command: unparseable } })).action).toBeUndefined()

    for (const [id, action] of [['allow-git', 'allow'], ['deny-rm', 'deny'], ['ask-git', 'ask']] as const) {
      const program = withRules([{ id, action, match: { kind: 'bash', pattern: action === 'deny' ? 'rm *' : 'git *' } }])
      for (const command of [unparseable, overLong]) {
        expect(evaluatePermissionDslV1(program, request({ input: { command } })).action).toBe('ask')
      }
    }

    // Direction proof, both halves. A deny that matches on its own terms still
    // wins over the carve-out...
    const denyEverything = withRules([
      { id: 'allow-git', action: 'allow', match: { kind: 'bash', pattern: 'git *' } },
      { id: 'deny-all', action: 'deny', match: { kind: 'tool', semanticId: 'bash' } },
    ])
    expect(evaluatePermissionDslV1(denyEverything, request({ input: { command: unparseable } }))).toMatchObject({
      action: 'deny', match: { ruleId: 'deny-all' },
    })
    // ...and a bare-tool ALLOW never survives the carve-out into an allow.
    const allowEverything = withRules([
      { id: 'allow-bash-tool', action: 'allow', match: { kind: 'tool', semanticId: 'bash' } },
      { id: 'allow-git', action: 'allow', match: { kind: 'bash', pattern: 'git *' } },
    ])
    expect(evaluatePermissionDslV1(allowEverything, request({ input: { command: unparseable } })).action).toBe('ask')
    expect(evaluatePermissionDslV1(allowEverything, request({ input: { command: 'git status' } })).action).toBe('allow')
  })

  const unparseableProgram = (rules: unknown[]) => compilePermissionDslV1({
    generation: 'generation-1',
    projectTrusted: false,
    canonicalizeRoot: canonicalizeForDecision,
    layers: rules.length > 0 ? [layer('workspace', rules)] : [],
  })
  const UNPARSEABLE = 'echo "unbalanced'
  const OVER_LONG = `echo ${'a'.repeat(10_001)}`

  test('the unparseable carve-out no longer waits for a Bash pattern rule to exist', () => {
    // permissions.md#read-only-commands — "when Claude Code can't fully parse a
    // command, it asks for approval instead of treating the command as
    // read-only. Commands longer than 10,000 characters always prompt because
    // they exceed what the analysis parses."
    //
    // `PROMPT_ANYWAY` is a per-RULE verdict returned from inside `matchesRule`'s
    // `bashPattern` branch, so it was reachable only once the compiled program
    // already carried a Claude-shaped `Bash(prefix)` rule. Measured on four
    // programs a real user can have (P2.311): no rules → no action; only
    // non-Bash rules → no action; a TOOL-level bash allow → **`allow`**; one
    // `Bash(tail:*)` deny → `ask`. Only the last reached the carve-out, and
    // Nessy ships no default `Bash(...)` rule — so the protection was absent for
    // a fresh profile and an outright APPROVAL for a profile that had granted
    // the Bash tool. Three separate plan rows had deferred work on the strength
    // of "PROMPT_ANYWAY covers that ground today".
    const programs: [string, unknown[], 'ask' | undefined, 'allow' | undefined][] = [
      ['no rules at all', [], undefined, undefined],
      ['only non-Bash rules', [{ id: 'allow-read', action: 'allow', match: { kind: 'tool', semanticId: 'read' } }], undefined, undefined],
      ['a TOOL-level bash allow', [{ id: 'allow-bash-tool', action: 'allow', match: { kind: 'tool', semanticId: 'bash' } }], 'ask', 'allow'],
      ['one Bash(tail:*) deny', [{ id: 'deny-tail', action: 'deny', match: { kind: 'bash', pattern: 'tail *' } }], 'ask', undefined],
    ]
    for (const [name, rules, unreadableAction, readableAction] of programs) {
      const program = unparseableProgram(rules)
      for (const command of [UNPARSEABLE, OVER_LONG]) {
        expect([name, evaluatePermissionDslV1(program, request({ input: { command } })).action])
          .toEqual([name, unreadableAction])
      }
      // Positive control on every row: a command the analysis CAN read resolves
      // by that row's rules, unchanged. Without it, an `ask` above could equally
      // be a matcher that fires on everything, and the two `undefined` rows
      // could equally be a program with no opinion about anything.
      expect([name, evaluatePermissionDslV1(program, request({ input: { command: 'git status' } })).action])
        .toEqual([name, readableAction])
    }
  })

  test('a tool-level Bash allow cannot approve a command the analysis could not read', () => {
    // The sharpest form of the defect and the reason it outranked its size: this
    // program is one line of user settings (`"allow": ["Bash"]`), it consults no
    // command text at all, and before P2.311 it returned `allow` on a command
    // nothing in the system could parse.
    const program = unparseableProgram([{ id: 'allow-bash-tool', action: 'allow', match: { kind: 'tool', semanticId: 'bash' } }])
    for (const command of [UNPARSEABLE, OVER_LONG, 'case a in a) rm -rf ~ ;; esac']) {
      expect(evaluatePermissionDslV1(program, request({ input: { command } }))).toMatchObject({
        action: 'ask', match: { ruleId: 'allow-bash-tool' },
      })
    }
    // The grant is untouched for every command the analysis can read — this is
    // an allow rule doing its job, and the carve-out is not allowed to erode it.
    for (const command of ['git status', 'rm -rf /tmp/x', 'ls | wc -l', "python3 - <<'PY'\nimport json\nPY"]) {
      expect(evaluatePermissionDslV1(program, request({ input: { command } })).action).toBe('allow')
    }
  })

  test('`Bash` and `Bash(*)` agree on an unparseable command, as permissions.md declares them equivalent', () => {
    // permissions.md#match-all-uses-of-a-tool — "`Bash(*)` is equivalent to
    // `Bash` and matches all Bash commands." `Bash` compiles to a `tool` matcher
    // and `Bash(*)` to a `bashPattern` one, so before P2.311 only the second
    // carried the carve-out: the two documented-equivalent spellings disagreed,
    // the bare one ALLOWING what the parenthesised one asked about.
    const fromClaudeRule = (specifier: string) => {
      const parsed = parseClaudeRuleString(specifier, 'allow')
      if (!parsed.rule) throw new Error(`unparsed specifier: ${specifier}`)
      return { id: 'allow-all', action: 'allow', match: parsed.rule.match }
    }
    for (const command of [UNPARSEABLE, OVER_LONG]) {
      const bare = evaluatePermissionDslV1(unparseableProgram([fromClaudeRule('Bash')]), request({ input: { command } })).action
      const star = evaluatePermissionDslV1(unparseableProgram([fromClaudeRule('Bash(*)')]), request({ input: { command } })).action
      expect([bare, star]).toEqual(['ask', 'ask'])
    }
    // Control: the equivalence is asserted on a command the analysis reads too,
    // so the test cannot pass by making both forms uniformly useless.
    const readable = request({ input: { command: 'git status' } })
    expect(evaluatePermissionDslV1(unparseableProgram([fromClaudeRule('Bash')]), readable).action).toBe('allow')
    expect(evaluatePermissionDslV1(unparseableProgram([fromClaudeRule('Bash(*)')]), readable).action).toBe('allow')
  })

  test('the carve-out downgrades an allow and does nothing else', () => {
    // It is a PROMPT, never a refusal, and never an opinion where there was
    // none. Both halves matter: manufacturing a deny would enforce a policy
    // nobody wrote, and manufacturing an action on a no-match would break
    // `evaluateClaudeHookIfFilter`'s documented fail-open, which compiles a
    // ONE-RULE allow program and reads a no-match as "do not run" — silently
    // stopping hooks.
    const denyWins = unparseableProgram([
      { id: 'allow-bash-tool', action: 'allow', match: { kind: 'tool', semanticId: 'bash' } },
      { id: 'deny-all', action: 'deny', match: { kind: 'parameter', name: 'command', matches: '*' } },
    ])
    expect(evaluatePermissionDslV1(denyWins, request({ input: { command: UNPARSEABLE } }))).toMatchObject({
      action: 'deny', match: { ruleId: 'deny-all' },
    })

    // An `ask` rule is already an ask, and keeps its own rule id rather than
    // being restamped by the carve-out.
    const askProgram = unparseableProgram([{ id: 'ask-bash-tool', action: 'ask', match: { kind: 'tool', semanticId: 'bash' } }])
    expect(evaluatePermissionDslV1(askProgram, request({ input: { command: UNPARSEABLE } }))).toMatchObject({
      action: 'ask', match: { ruleId: 'ask-bash-tool' },
    })

    // A non-Bash request carrying no command is untouched, however unreadable
    // some other request's command might be.
    const readAllow = unparseableProgram([{ id: 'allow-read', action: 'allow', match: { kind: 'tool', semanticId: 'read' } }])
    expect(evaluatePermissionDslV1(readAllow, request({
      semanticId: 'read', toolName: 'Read', input: { file_path: '/workspace/a.ts' },
    })).action).toBe('allow')

    // The `invalid-policy` carrier still reports a SKIPPED rule with NO action
    // on an unparseable command — the shape `evaluateClaudeHookIfFilter` reads.
    const dropped = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      canonicalizeRoot: canonicalizeForDecision,
      layers: [layer('workspace', [{ id: 'relative', action: 'allow', match: { kind: 'path', root: '.' } }])],
    })
    expect(dropped.droppedRules.map(rule => rule.id)).toEqual(['relative'])
    const verdict = evaluatePermissionDslV1(dropped, request({ input: { command: UNPARSEABLE } }))
    expect(verdict.action).toBeUndefined()
    expect(verdict.match).toMatchObject({ ruleId: 'invalid-policy' })
  })

  test('rawDslInputPath returns the single raw path parameter and refuses ambiguity', () => {
    // The helper feeds `rawInputPath` at the gate call sites (R1 follow-up).
    expect(rawDslInputPath({ file_path: 'ok/link', content: 'x' })).toBe('ok/link')
    expect(rawDslInputPath({ command: 'ls', cwd: '/workspace/link' })).toBe('/workspace/link')
    expect(rawDslInputPath({ command: 'ls' })).toBeUndefined()
    // Identical duplicates are unambiguous; distinct path parameters are not —
    // rawInputPath applies to every parameter, so pairing would be wrong.
    expect(rawDslInputPath({ path: '/a', cwd: '/a' })).toBe('/a')
    expect(rawDslInputPath({ file_path: '/a', cwd: '/b' })).toBeUndefined()
  })

  test('a whole-tool deny cannot remove EndConversation while any other tool remains', () => {
    // permissions.md (R1 follow-up, enforced at the manifest consumer): bare
    // name and glob deny/ask rules never strip EndConversation while another
    // tool survives; alone, it goes like any other tool.
    const identities = [
      { bindingName: 'bash', piName: 'bash', semanticId: 'bash', permissionName: 'Bash' },
      { bindingName: 'end_conversation', piName: 'EndConversation', semanticId: 'end-conversation', permissionName: 'EndConversation' },
    ]
    const program = (semanticId: string) => compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      canonicalizeRoot: canonicalizeForDecision,
      layers: [layer('managed', [
        { id: 'deny-tool', action: 'deny', match: { kind: 'tool', semanticId } },
      ])],
    })

    // Bare-name deny on EndConversation: kept while bash remains.
    expect(filterCapabilityIdentitiesByWholeToolDeny(identities, program('EndConversation'))
      .map(identity => identity.bindingName)).toEqual(['bash', 'end_conversation'])
    // Glob deny reaching it: same exception.
    expect(filterCapabilityIdentitiesByWholeToolDeny(identities, program('End*'))
      .map(identity => identity.bindingName)).toEqual(['bash', 'end_conversation'])
    // Alone, it is removable like any other tool.
    expect(filterCapabilityIdentitiesByWholeToolDeny([identities[1]!], program('EndConversation'))).toEqual([])
    // A deny on another tool is unaffected by the exception.
    expect(filterCapabilityIdentitiesByWholeToolDeny(identities, program('bash'))
      .map(identity => identity.bindingName)).toEqual(['end_conversation'])
  })

  test('every documented whole-tool deny form removes the tool and still denies at the gate', () => {
    // permissions.md:82 — "`Bash(*)` is equivalent to `Bash` and matches all
    // Bash commands. As a deny rule, both forms remove the tool from Claude's
    // context." — and :142 — "A tool matched by a bare-name glob deny rule is
    // removed from Claude's context, the same as a bare tool name".
    const identities = [
      { bindingName: 'bash', piName: 'bash', semanticId: 'bash', permissionName: 'Bash' },
      { bindingName: 'bash_background', piName: 'bash_background', semanticId: 'bash_background', permissionName: 'Bash' },
      { bindingName: 'read', piName: 'read', semanticId: 'read', permissionName: 'Read' },
      { bindingName: 'mcp__session__Monitor', piName: 'mcp__session__Monitor', semanticId: 'monitor', permissionName: 'Monitor' },
      { bindingName: 'mcp__github__get_issue', piName: 'mcp__github__get_issue', semanticId: 'mcp_dynamic', permissionName: 'mcp__github__get_issue' },
      { bindingName: 'mcp__gitlab__list', piName: 'mcp__gitlab__list', semanticId: 'mcp_dynamic', permissionName: 'mcp__gitlab__list' },
    ]
    const program = (rule: string, action: 'deny' | 'ask' = 'deny') => {
      const parsed = parseClaudeRuleString(rule, action)
      if (!parsed.rule) throw new Error(`inert rule: ${rule}`)
      return compilePermissionDslV1({
        generation: 'generation-1',
        projectTrusted: false,
        canonicalizeRoot: canonicalizeForDecision,
        layers: [layer('managed', [{ id: 'whole-tool', ...parsed.rule }])],
      })
    }
    const kept = (rule: string) => filterCapabilityIdentitiesByWholeToolDeny(identities, program(rule))
      .map(identity => identity.bindingName)

    // A bare canonical name removes every binding that answers to it.
    expect(kept('Bash')).toEqual(['read', 'mcp__session__Monitor', 'mcp__github__get_issue', 'mcp__gitlab__list'])
    // `Bash(*)` is the same rule written the other way.
    expect(kept('Bash(*)')).toEqual(['read', 'mcp__session__Monitor', 'mcp__github__get_issue', 'mcp__gitlab__list'])
    // A specifier'd Bash deny leaves the tool present.
    expect(kept('Bash(git *)')).toEqual(identities.map(identity => identity.bindingName))
    // MCP tool-name globs and a bare MCP tool name, at all three widths.
    expect(kept('mcp__*')).toEqual(['bash', 'bash_background', 'read', 'mcp__session__Monitor'])
    expect(kept('mcp__github__*')).toEqual(['bash', 'bash_background', 'read', 'mcp__session__Monitor', 'mcp__gitlab__list'])
    expect(kept('mcp__github__get_issue'))
      .toEqual(['bash', 'bash_background', 'read', 'mcp__session__Monitor', 'mcp__gitlab__list'])

    // ...and the gate still denies, so removal never stands in for enforcement.
    for (const rule of ['Bash', 'Bash(*)']) {
      expect(evaluatePermissionDslV1(program(rule), request()).action).toBe('deny')
    }
    for (const rule of ['mcp__*', 'mcp__github__*', 'mcp__github__get_issue']) {
      expect(evaluatePermissionDslV1(program(rule), request({
        semanticId: 'mcp_dynamic', toolName: 'mcp__github__get_issue', input: {},
      })).action).toBe('deny')
    }
    // A specifier'd deny is not whole-tool, and the gate still applies it.
    expect(evaluatePermissionDslV1(program('Bash(git *)'), request()).action).toBe('deny')
    expect(evaluatePermissionDslV1(program('Bash(git *)'), request({ input: { command: 'ls' } })).action)
      .toBeUndefined()
  })

  test('identifies only whole-capability denies for catalog suppression', () => {
    const program = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      canonicalizeRoot: canonicalizeForDecision,
      layers: [layer('managed', [
        { id: 'hide-delete', action: 'deny', match: { kind: 'tool', semanticId: 'mcp__gitlab__delete_*' } },
        { id: 'scoped-path', action: 'deny', match: { kind: 'path', root: '/private' } },
      ])],
    })
    expect(isWholeCapabilityDeniedByPermissionDsl(program, 'mcp__gitlab__delete_project')).toBe(true)
    expect(isWholeCapabilityDeniedByPermissionDsl(program, 'mcp__gitlab__get_project')).toBe(false)
  })
})

/**
 * P2.329 — `wildcard()` compiled `*` to `.` without `s`, so a `matches:` glob
 * silently failed on any value carrying a line terminator. It is the only one
 * of that function's callers that can see one: ids and names cannot contain a
 * terminator, and the `exec` matcher is fed by `tokenizeShell`, which returns
 * null outright on `\r` or `\n`.
 */
describe('a `matches:` wildcard crosses a line terminator', () => {
  // A literal line break; the two-character escape matched even when broken.
  const LF = `
`

  test('a parameter deny is not evadable by a multi-line value', () => {
    const program = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: false,
      layers: [layer('workspace', [
        { id: 'deny-secret', action: 'deny', match: { kind: 'parameter', name: 'note', matches: '*secret*' } },
        { id: 'deny-any-tag', action: 'deny', match: { kind: 'parameter', name: 'tag', matches: '*' } },
      ])],
    })
    const decide = (input: Record<string, unknown>) =>
      evaluatePermissionDslV1(program, request({ input })).action

    // Controls: single-line values match, and an unrelated value does not — so
    // `undefined` below is a real verdict and `deny` is this rule firing.
    expect(decide({ command: 'x', note: 'a secret b' })).toBe('deny')
    expect(decide({ command: 'x', note: 'nothing here' })).toBeUndefined()
    // The bypass: one newline in the value and the deny vanished.
    expect(decide({ command: 'x', note: `a${LF}secret${LF}b` })).toBe('deny')
    // A bare `*` must match every value — permissions.md#match-by-input-parameter,
    // "The value supports `*` as a wildcard that matches any sequence of
    // characters". A multi-line value is a sequence of characters.
    expect(decide({ command: 'x', tag: `one${LF}two` })).toBe('deny')
    // Exactness is untouched: `matches` without a `*` is still literal.
    expect(evaluatePermissionDslV1(
      compilePermissionDslV1({
        generation: 'generation-1',
        projectTrusted: false,
        layers: [layer('workspace', [
          { id: 'exact', action: 'deny', match: { kind: 'parameter', name: 'note', matches: 'abc' } },
        ])],
      }),
      request({ input: { command: 'x', note: `abc${LF}` } }),
    ).action).toBeUndefined()
  })
})

/**
 * F1.784 — a native STRUCTURAL `bash` rule (`{ kind: 'bash', executable, args? }`,
 * the shape codex's Always allow writes through `mergeExecpolicyAllowGrant`) and a
 * command the structural tokenizer cannot split (`;`, `>>`, `&&`, `$(…)`, a glob).
 * Before the fix EVERY such rule answered the terminal "unsafe or unsupported
 * syntax" deny whatever its action, so one Always-allow for `git` refused a user's
 * `printf …; true` hook and the model's own `echo a; echo b` in every mode. The
 * rule's ACTION now decides: an allow does not match (the next rule, then the mode's default,
 * decides — as with no rule at all), an ask asks, a deny denies — since F1.816 (deny) and F1.1245
 * (ask) a rule naming a program only when a subcommand runs it, or the command cannot be split.
 */
describe('F1.784 — an unparseable command under a structural bash rule', () => {
  const UNPARSEABLE = ['echo a; echo b', 'echo x >> hook.log', `printf '%s' 'x'; true`, 'git status && rm -rf x', 'echo $(whoami)', 'cat *.pem']
  const ALWAYS_ALLOW_GIT = { id: 'codex-execpolicy-git', action: 'allow', match: { kind: 'bash', executable: 'git' } }
  const programOf = (rules: unknown[]) => compilePermissionDslV1({
    generation: 'generation-1',
    projectTrusted: false,
    canonicalizeRoot: canonicalizeForDecision,
    layers: [layer('workspace', rules)],
  })
  const decide = (rules: unknown[], command: string) =>
    evaluatePermissionDslV1(programOf(rules), request({ input: { command } }))

  test('an ALLOW rule for an unrelated program neither approves nor refuses it — the same answer as no rule at all', () => {
    for (const command of UNPARSEABLE) {
      const withRule = decide([ALWAYS_ALLOW_GIT], command)
      expect(withRule.action, command).toBeUndefined()
      expect(withRule.diagnostic, command).toBeUndefined()
      // CONTROL: the identical command with no rule.
      expect(decide([], command), command).toEqual(withRule)
    }
  })

  test('an ALLOW rule falls through to the rule after it', () => {
    // A later deny decides, and the refusal names THAT rule, not the allow.
    const denyRm = { id: 'deny-rm', action: 'deny', match: { kind: 'bash', pattern: 'rm *' }, text: 'Bash(rm *)' }
    expect(decide([ALWAYS_ALLOW_GIT, denyRm], 'git status && rm -rf x')).toMatchObject({ action: 'deny', match: { ruleId: 'deny-rm' } })
    // A later Claude allow whose analysis CAN read the command decides too.
    const allowEcho = { id: 'allow-echo', action: 'allow', match: { kind: 'bash', pattern: 'echo *' }, text: 'Bash(echo *)' }
    expect(decide([ALWAYS_ALLOW_GIT, allowEcho], 'echo a; echo b')).toMatchObject({ action: 'allow', match: { ruleId: 'allow-echo' } })
  })

  test('an ASK rule asks, naming the rule, and never refuses — since F1.1245 only for a command that runs its program', () => {
    const askGit = { id: 'ask-git', action: 'ask', match: { kind: 'bash', executable: 'git' } }
    for (const command of UNPARSEABLE) {
      const result = decide([askGit], command)
      if (command.startsWith('git ')) expect(result, command).toMatchObject({ action: 'ask', match: { ruleId: 'ask-git' } })
      else expect(result, command).toEqual(decide([], command)) // CONTROL: the identical command with no rule
    }
  })

  test('CONTROL: a DENY rule still refuses an unparseable command that runs its program — and, since F1.816, only one that does', () => {
    const denyGit = { id: 'deny-git', action: 'deny', match: { kind: 'bash', executable: 'git' } }
    for (const command of UNPARSEABLE) {
      const result = decide([ALWAYS_ALLOW_GIT, denyGit], command)
      if (command.startsWith('git ')) expect(result, command).toMatchObject({ action: 'deny', match: { ruleId: 'deny-git' } })
      else expect(result.action, command).toBeUndefined()
    }
  })

  test('CONTROL: a command the tokenizer CAN split is judged by every rule exactly as before', () => {
    const rulesFor = (action: string) => [{ id: `${action}-git`, action, match: { kind: 'bash', executable: 'git' } }]
    for (const action of ['allow', 'ask', 'deny'] as const) {
      expect(decide(rulesFor(action), 'git status').action, action).toBe(action)
      expect(decide(rulesFor(action), 'env CI=1 command git status').action, action).toBe(action)
      expect(decide(rulesFor(action), 'ls -la').action, action).toBeUndefined()
    }
    // A Claude pattern rule over the same unparseable text is untouched too.
    const claude = { id: 'claude-git-status', text: 'Bash(git status)', ...parseClaudeRuleString('Bash(git status)', 'allow').rule! }
    expect(decide([claude], 'echo a; echo b').action).toBeUndefined()
  })
})

/**
 * F1.863 — the DENY half of F1.784's seam. A structural `bash` DENY rule refuses
 * a command the tokenizer cannot split when the compound runs the denied program
 * (since F1.816 read from its subcommands; a rule for EVERY program still refuses
 * them all), and the refusal NAMES the rule and its scope — as a bare match
 * already did. Before this, SIT-x's `sitx-deny-touch` refused a user's
 * `printf …; true` hook and the model's own `touch x; echo y` with "Shell command
 * contains unsafe or unsupported syntax." and nothing else; only a bare `touch`
 * named the rule, so the model found the rule by bisecting.
 */
describe('F1.863 — an unparseable command under a structural bash DENY rule', () => {
  const SITX_DENY_TOUCH = { id: 'sitx-deny-touch', action: 'deny', match: { kind: 'bash', executable: 'touch' } }
  const decide = (rules: unknown[], command: string) => evaluatePermissionDslV1(compilePermissionDslV1({
    generation: 'generation-1',
    projectTrusted: false,
    canonicalizeRoot: canonicalizeForDecision,
    layers: [layer('workspace', rules)],
  }), request({ input: { command } }))

  test('one that runs the denied program is still refused, and the refusal names the rule and its scope', () => {
    for (const command of ['touch sitx-deny.txt; echo done-deny', `printf '%s' '{"hookSpecificOutput":{}}'; touch x`]) {
      const result = decide([SITX_DENY_TOUCH], command)
      expect(result, command).toMatchObject({ action: 'deny', match: { ruleId: 'sitx-deny-touch', scope: 'workspace' } })
      expect(permissionDslDenyReason(result), command).toBe('Denied by readable permission policy rule `sitx-deny-touch` (workspace scope).')
      expect(permissionDslDenyReason(result), command).not.toContain(command) // the command itself is never echoed
    }
  })

  test('names the rule by its own text when it has one, and leaves a wildcard program unnamed', () => {
    const withText = { ...SITX_DENY_TOUCH, text: 'no touching' }
    expect(permissionDslDenyReason(decide([withText], 'touch a; true'))).toContain('rule `no touching` (workspace scope)')
    const wildcard = { id: 'deny-any-program', action: 'deny', match: { kind: 'bash', executable: '*' } }
    expect(decide([wildcard], 'echo a; echo b').diagnostic?.message).toBe(
      'Denied by readable permission policy rule `deny-any-program` (workspace scope): the shell command contains '
      + 'unsafe or unsupported syntax, so the rule cannot tell whether it runs a program it denies.',
    )
  })

  test('CONTROL: a bare match of the denied program keeps the sentence it always had', () => {
    const result = decide([SITX_DENY_TOUCH], 'touch sitx-deny.txt')
    expect(result).toMatchObject({ action: 'deny', match: { ruleId: 'sitx-deny-touch' } })
    expect(result.diagnostic).toBeUndefined()
    expect(permissionDslDenyReason(result)).toBe('Denied by readable permission policy rule `sitx-deny-touch` (workspace scope).')
  })

  test('CONTROL: a command the rule can read and that is not its program decides nothing', () => {
    expect(decide([SITX_DENY_TOUCH], 'true').action).toBeUndefined()
    expect(decide([SITX_DENY_TOUCH], 'git status').action).toBeUndefined()
  })
})

/**
 * F1.816 (owner decision 2026-09-26, option a) — a structural `bash` DENY rule
 * over a command the structural tokenizer cannot split reads the command's
 * SUBCOMMANDS through the Claude analysis (`matchClaudeBashRule` with
 * `<program> *`, or `<program> <args> *`): one that runs the program is refused as
 * a bare match is, one that does not decides nothing, and one the Claude analysis
 * cannot read either asks, as a `Bash(…)` rule does. A rule for EVERY program
 * still refuses them all. Before, one `touch` deny refused every unsplittable
 * command in every mode, hooks included — `echo a; echo b` as much as `a; touch x`.
 */
describe('F1.816 — a structural bash DENY rule judges an unsplittable command by its subcommands', () => {
  const DENY_TOUCH = { id: 'deny-touch', action: 'deny', match: { kind: 'bash', executable: 'touch' } }
  const decide = (rules: unknown[], command: string, cwd = '/workspace') => evaluatePermissionDslV1(compilePermissionDslV1({
    generation: 'generation-1',
    projectTrusted: false,
    canonicalizeRoot: canonicalizeForDecision,
    layers: [layer('workspace', rules)],
  }), request({ input: { command }, cwd }))

  test('refuses a command one of whose subcommands runs the program, naming the rule as a bare match does', () => {
    const commands = ['touch x; echo y', 'echo a && touch x', 'echo $(touch x)', 'sudo touch x >> log', 'echo a; /usr/bin/touch x',
      `bash -c 'touch x; ls'`, 'if true; then touch x; fi', 'echo a | touch x']
    for (const command of commands) {
      const result = decide([DENY_TOUCH], command)
      expect(result, command).toMatchObject({ action: 'deny', match: { ruleId: 'deny-touch', scope: 'workspace' } })
      expect(permissionDslDenyReason(result), command).toBe('Denied by readable permission policy rule `deny-touch` (workspace scope).')
    }
  })

  test('decides nothing on a command none of whose subcommands runs the program — the same answer as no rule at all', () => {
    const commands = ['echo a; echo b', `printf '%s' '{"hookSpecificOutput":{}}'; true`, 'echo x >> touch.log', 'echo $(whoami)',
      'cat *.pem', 'echo touch; ls', 'retouch x; ls']
    for (const command of commands) {
      const result = decide([DENY_TOUCH], command)
      expect(result.action, command).toBeUndefined()
      expect(decide([], command), command).toEqual(result) // CONTROL: the identical command with no rule
    }
  })

  test('a rule with args reads them as `<program> <args> *`', () => {
    const denyPush = { id: 'deny-git-push', action: 'deny', match: { kind: 'bash', executable: 'git', args: ['push'] } }
    expect(decide([denyPush], 'git fetch && git push origin main').action).toBe('deny')
    expect(decide([denyPush], 'git status; git diff').action).toBeUndefined()
  })

  test('BOUNDARY: asks, naming the rule, when the Claude analysis cannot read the command either', () => {
    const unreadable = `echo a; ${'x'.repeat(10_001)}` // past the analysis' 10,000-character limit
    expect(decide([DENY_TOUCH], unreadable)).toMatchObject({ action: 'ask', match: { ruleId: 'deny-touch' } })
  })

  test('BOUNDARY: a rule for every program still refuses every unsplittable command', () => {
    const denyAll = { id: 'deny-any-program', action: 'deny', match: { kind: 'bash', executable: '*' } }
    for (const command of ['echo a; echo b', 'echo $(whoami)']) {
      expect(decide([denyAll], command), command).toMatchObject({ action: 'deny', match: { ruleId: 'deny-any-program' } })
    }
  })

  test('BOUNDARY: the rule\'s cwdRoot scopes the subcommand match exactly as it scopes a bare one', () => {
    const scoped = { id: 'deny-touch-here', action: 'deny', match: { kind: 'bash', executable: 'touch', cwdRoot: '/workspace' } }
    expect(decide([scoped], 'touch x; true').action).toBe('deny')
    expect(decide([scoped], 'touch x; true', '/elsewhere').action).toBeUndefined()
    expect(decide([scoped], 'touch x', '/elsewhere').action).toBeUndefined() // CONTROL: the bare command, same cwd
  })
})

/**
 * F1.1245 (final sitting SIT2-b FAIL 3, 2026-10-01) — a structural `bash` ASK rule
 * over a command the structural tokenizer cannot split reads the SUBCOMMANDS the
 * way F1.816's deny does (`permissions.md#compound-commands`: "Deny and ask rules
 * apply when any subcommand matches them"). Before, one workspace ask for
 * `touch sit2b-ask.txt` carded every compound or redirected Bash on claude in
 * Bypass too, naming that rule.
 */
describe('F1.1245 — a structural bash ASK rule judges an unsplittable command by its subcommands', () => {
  const ASK_TOUCH = { id: 'ask-touch-sit2b', action: 'ask', match: { kind: 'bash', executable: 'touch', args: ['sit2b-ask.txt'] } }
  const decide = (rules: unknown[], command: string) => evaluatePermissionDslV1(compilePermissionDslV1({
    generation: 'generation-1',
    projectTrusted: false,
    canonicalizeRoot: canonicalizeForDecision,
    layers: [layer('workspace', rules)],
  }), request({ input: { command } }))

  test('asks, naming the rule, when one subcommand runs the rule\'s command', () => {
    for (const command of ['cd /workspace && touch sit2b-ask.txt', 'echo "$(touch sit2b-ask.txt)"', 'touch sit2b-ask.txt >> log; echo ok']) {
      expect(decide([ASK_TOUCH], command), command).toMatchObject({ action: 'ask', match: { ruleId: 'ask-touch-sit2b', scope: 'workspace' } })
    }
  })

  test('decides nothing on the sitting\'s unrelated compound and redirected commands — the same answer as no rule at all', () => {
    const commands = ['ls -la /workspace/ws-b/ 2>&1', 'echo "1" >> goal-count.txt && wc -l goal-count.txt',
      'cd /workspace && if [ -f goal-count.txt ]; then wc -l goal-count.txt; else echo none; fi', 'touch other.txt; echo y']
    for (const command of commands) {
      const result = decide([ASK_TOUCH], command)
      expect(result.action, command).toBeUndefined()
      expect(decide([], command), command).toEqual(result)
    }
  })
})

// F1.1187 (origin the do-now adversarial review, 2026-09-29) — a policy that fails closed refuses every call with the
// reason of the document that FAILED it. The evaluator took `diagnostics[0]`, so an earlier document's F1.831
// announcement ("... was ignored as a whole; every other permission document still applies") became the text of a
// refusal it contradicts, naming the wrong file — on Pi, and since F1.1002 on claude, codex and the Monitor gate too
// (all through `permissionDslDenyReason`).
describe('F1.1187 · a policy that fails closed refuses with its own reason', () => {
  const read = () => request({ semanticId: 'read', toolName: 'Read', input: { file_path: '/workspace/a.ts' } })
  const denies = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `d${index}`, action: 'deny', match: { kind: 'tool', semanticId: `T${index}` } }))

  test('FAILING ARM: a dropped global document before a workspace source over the rule cap does not lend its announcement', async () => {
    const program = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: true,
      layers: [layer('global', [], { document: { version: 1, rules: 'nope' } }), layer('workspace', denies(513))],
    })
    expect(program.invalidSource?.scope).toBe('workspace')
    expect(program.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['invalid-document', 'rule-cap']) // the notice keeps both
    const verdict = evaluatePermissionDslV1(program, read())
    expect(verdict).toMatchObject({ action: 'deny', match: { ruleId: 'invalid-policy', scope: 'workspace' }, diagnostic: { code: 'rule-cap' } })
    expect(Object.keys(verdict.match!).sort()).toEqual(['ruleId', 'scope', 'sourceDigest']) // the source only, as before
    const reason = permissionDslDenyReason(verdict)
    expect(reason).toContain('513 deny/ask permission rules')
    expect(reason).not.toContain('ignored as a whole')
    // Pi's removal card for a tool the failed policy took out reads the same sentence.
    const { piWholeToolDenyRefusals } = await import('./session-tool-rule-alias.ts')
    const refusals = piWholeToolDenyRefusals({ tools: [] }, [{ bindingName: 'read', piName: 'read', semanticId: 'read', permissionName: 'Read' }], program)
    expect(refusals?.get('read')?.refusal).toBe(reason)
  })

  test('SECOND ARM and BOUNDARY: a managed document whose own rule was skipped before its fatal error names the fatal error; a lone failure keeps its sentence', () => {
    const managed = compilePermissionDslV1({
      generation: 'generation-1',
      projectTrusted: true,
      layers: [layer('managed', [
        { id: 'too-long', action: 'deny', match: { kind: 'tool', semanticId: 'x'.repeat(300) } },
        { id: 'unknown', action: 'allow', match: { kind: 'substring', value: 'rm' } },
      ])],
    })
    expect(managed.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['unparseable-rule', 'unknown-matcher'])
    expect(evaluatePermissionDslV1(managed, read())).toMatchObject({ action: 'deny', match: { scope: 'managed' }, diagnostic: { code: 'unknown-matcher' } })
    const alone = compilePermissionDslV1({ generation: 'generation-1', projectTrusted: true, layers: [layer('workspace', denies(513))] })
    expect(permissionDslDenyReason(evaluatePermissionDslV1(alone, read()))).toContain('513 deny/ask permission rules')
  })
})

/**
 * UA12.196 `[permissions]` `[pi]` — Pi's durable matcher (`matchClaudeBashRule`, read by
 * `evaluatePermissionDslV1`) read a pure fd-form stderr merge as command text, so the rule an
 * Always Allow on `npm test 2>&1` writes — `Bash(npm test)`, since UA12.87 keys the producer —
 * did not match `npm test 2>&1` in a later session, and it asked again.
 * permissions.md#redirections: "Targets with no file behind them aren't checked: `/dev/null`,
 * file-descriptor forms such as `2>&1` and `<&3`". The matcher now also tries the rule against
 * the subcommand without a trailing ` 2>&1` (the key side's one spelling); a file redirect keeps
 * its target and still asks, and a deny reads the same text, so it is never weaker than the allow.
 */
describe('UA12.196 — a durable Bash(npm test) covers `npm test 2>&1` on Pi; a file redirect still asks', () => {
  const compile = (rules: unknown[]) => compilePermissionDslV1({
    generation: 'generation-1',
    projectTrusted: true,
    layers: [layer('workspace', rules)],
  })
  const durable = compile([{ id: 'durable', action: 'allow', match: { kind: 'bash', pattern: 'npm test' }, text: 'Bash(npm test)' }])
  const verdict = (command: string) => evaluatePermissionDslV1(durable, request({ input: { command } })).action

  test('the durable rule allows the stderr-merged line, as it allows the bare one', () => {
    expect(verdict('npm test')).toBe('allow')
    expect(verdict('npm test 2>&1')).toBe('allow')
  })

  test('BOUNDARY: a file redirect, a chained command, a pipe stage and an escaped space are not covered', () => {
    for (const command of ['npm test > out.txt', 'npm test > out.txt 2>&1', 'npm test 2>&1 && rm -rf x', 'npm test 2>&1 | tee log.txt', 'npm test\\ 2>&1', 'npm test 2>&1 x']) {
      expect({ command, action: verdict(command) }).toEqual({ command, action: undefined })
    }
  })

  test('a durable deny reads the same text: Bash(rm -rf build) denies `rm -rf build 2>&1`', () => {
    const program = compile([{ id: 'deny', action: 'deny', match: { kind: 'bash', pattern: 'rm -rf build' }, text: 'Bash(rm -rf build)' }])
    expect(evaluatePermissionDslV1(program, request({ input: { command: 'rm -rf build 2>&1' } })).action).toBe('deny')
    expect(evaluatePermissionDslV1(program, request({ input: { command: 'rm -rf dist 2>&1' } })).action).toBeUndefined()
  })
})

/**
 * F1.1143 (origin DN-196 proposed row 3) — since F1.816 a structural deny's
 * compound seam asks `matchClaudeBashRule`'s deny reading, which compared the
 * head AS WRITTEN: the second command of `echo a; 'touch' x` ran `touch`, and
 * the reading said `no-match` (measured at HEAD 2026-10-09, probe in
 * work/bk-18/). With the deny reading head-resolved (F1.1143), the compound
 * refuses as the bare form always has.
 */
describe('F1.1143 — a structural deny reads a quoted, escaped or exec-prefixed head inside a compound', () => {
  const DENY_TOUCH = { id: 'deny-touch', action: 'deny', match: { kind: 'bash', executable: 'touch' } }
  const decide = (rules: unknown[], command: string, cwd = '/workspace') => evaluatePermissionDslV1(compilePermissionDslV1({
    generation: 'generation-1',
    projectTrusted: false,
    canonicalizeRoot: canonicalizeForDecision,
    layers: [layer('workspace', rules)],
  }), request({ input: { command }, cwd }))

  test('refuses the compound whose second command spells the program quoted, escaped or behind exec', () => {
    for (const command of [`echo a; 'touch' x`, `echo a; \\touch x`, `echo a; exec touch x`, `echo a && exec 'touch' x`]) {
      expect(decide([DENY_TOUCH], command), command).toMatchObject({ action: 'deny', match: { ruleId: 'deny-touch', scope: 'workspace' } })
    }
  })

  test('negative: commands not running the program still decide nothing, quoted or not', () => {
    for (const command of [`echo a; echo b`, `echo 'touch'; true`, `echo a; \\echo b`, `retouch x; 'echo' b`]) {
      expect(decide([DENY_TOUCH], command).action, command).toBeUndefined()
    }
  })
})
