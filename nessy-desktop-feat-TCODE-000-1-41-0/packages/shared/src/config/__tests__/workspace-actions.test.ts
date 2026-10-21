/**
 * P6.361 — the workspace-action store.
 *
 * Two properties carry the row and each has its own block below: the parser
 * REFUSES rather than defaults (every entry is a shell command someone will
 * click, so a value that was almost right must not become one that runs), and
 * the operator's own kill switch is honoured at the READ, so a caller that
 * forgets to ask cannot offer a disabled action.
 */
import { describe, expect, test } from 'bun:test'

import {
  MAX_ACTIONS,
  MAX_ACTION_COMMAND_LENGTH,
  MAX_ACTION_NAME_LENGTH,
  WORKSPACE_ACTIONS_SETTING_KEY,
  getWorkspaceActions,
  parseWorkspaceActions,
  resolveWorkspaceActionCwd,
  resolveWorkspaceActions,
  workspaceActionsDisabled,
} from '../workspace-actions.ts'

const action = (over: Record<string, unknown> = {}) => ({
  id: 'dev', name: 'Dev server', command: 'bun run dev', ...over,
})

describe('the parser refuses rather than defaults', () => {
  test('an absent list is no actions, and that is the default', () => {
    expect(parseWorkspaceActions(undefined)).toEqual([])
  })

  test('a well-formed list parses, and a plain string means both interpreters', () => {
    const parsed = parseWorkspaceActions([action()])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.command).toEqual({ windows: 'bun run dev', posix: 'bun run dev' })
  })

  test.each([
    ['not an array', {}],
    ['an entry that is not an object', ['bun run dev']],
    ['an unknown key', [action({ shell: 'zsh' })]],
    ['a missing id', [{ name: 'Dev', command: 'x' }]],
    ['a blank name', [action({ name: '  ' })]],
    ['a name past the cap', [action({ name: 'x'.repeat(MAX_ACTION_NAME_LENGTH + 1) })]],
    ['a duplicate id', [action(), action({ name: 'Other' })]],
    ['a non-string command', [action({ command: 42 })]],
    ['a blank command', [action({ command: '   ' })]],
    ['a command past the cap', [action({ command: 'x'.repeat(MAX_ACTION_COMMAND_LENGTH + 1) })]],
    ['an unknown platform bucket', [action({ command: { darwin: 'x' } })]],
    ['a command object with neither half', [action({ command: {} })]],
    ['more actions than the cap', Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => action({ id: `a${i}` }))],
  ])('refuses %s', (_label, value) => {
    expect(() => parseWorkspaceActions(value)).toThrow()
  })

  test('a NUL byte in a command is refused — it would TRUNCATE the command that runs', () => {
    // The one malformed value whose failure mode is silent: a NUL cannot cross
    // an argv boundary intact, so a command carrying one runs a PREFIX of what
    // was declared. Written as an escape so this file stays greppable.
    expect(() => parseWorkspaceActions([action({ command: 'rm -rf \u0000 /tmp/x' })])).toThrow(/NUL/)
  })

  test('a cwd that leaves the workspace is refused by name', () => {
    expect(() => parseWorkspaceActions([action({ cwd: '/etc' })])).toThrow(/absolute/)
    expect(() => parseWorkspaceActions([action({ cwd: 'C:\\Windows' })])).toThrow(/absolute/)
    expect(() => parseWorkspaceActions([action({ cwd: '../../etc' })])).toThrow(/\.\./)
    expect(() => parseWorkspaceActions([action({ cwd: 'apps\\..\\..\\etc' })])).toThrow(/\.\./)
    // Positive control on the same rule: a plain relative path is accepted, so
    // the four refusals above are the rule firing and not the parser refusing
    // every `cwd`.
    expect(parseWorkspaceActions([action({ cwd: 'apps/electron' })])[0]?.cwd).toBe('apps/electron')
  })

  test('the refusal names the setting and the entry', () => {
    // A person who wrote a bad declaration has no other route back to the cause.
    expect(() => parseWorkspaceActions([action({ command: '' })]))
      .toThrow(new RegExp(`${WORKSPACE_ACTIONS_SETTING_KEY}.*\\[0\\]\\.command`))
  })
})

describe('the platform choice', () => {
  const both = parseWorkspaceActions([
    action({ id: 'a', command: { posix: 'make test', windows: 'nmake test' } }),
    action({ id: 'b', command: { posix: 'ls' } }),
    action({ id: 'c', command: { windows: 'dir' } }),
  ])

  test('posix hosts get the posix half and drop the windows-only action', () => {
    expect(resolveWorkspaceActions(both, 'darwin').map(a => [a.id, a.command]))
      .toEqual([['a', 'make test'], ['b', 'ls']])
    expect(resolveWorkspaceActions(both, 'linux').map(a => a.id)).toEqual(['a', 'b'])
  })

  test('windows gets the windows half and drops the posix-only action', () => {
    expect(resolveWorkspaceActions(both, 'win32').map(a => [a.id, a.command]))
      .toEqual([['a', 'nmake test'], ['c', 'dir']])
  })

  test('an action for the other platform is DROPPED, not offered and failed', () => {
    // A button that cannot work is worse than an absent one, and this is the
    // same answer a Windows-only `setupScript` gets on macOS.
    expect(resolveWorkspaceActions(both, 'darwin').some(a => a.id === 'c')).toBe(false)
  })
})

describe("the operator's kill switch", () => {
  const config = { [WORKSPACE_ACTIONS_SETTING_KEY]: [action()] }

  test('actions are read when nothing is disabled', () => {
    expect(getWorkspaceActions(config, 'darwin').map(a => a.name)).toEqual(['Dev server'])
  })

  test('disableSkillShellExecution empties the list AT THE READ', () => {
    // Enforced here rather than at every call site, so a caller that forgets to
    // ask cannot offer a disabled action.
    expect(workspaceActionsDisabled({ disableSkillShellExecution: true })).toBe(true)
    expect(getWorkspaceActions({ ...config, disableSkillShellExecution: true }, 'darwin')).toEqual([])
  })

  test('only the JSON boolean true counts', () => {
    // `bundled-skills-settings.ts`'s rule: an unrecognised value is "not set"
    // rather than an error that would take the whole config layer down.
    for (const value of ['true', 1, {}, null]) {
      expect(workspaceActionsDisabled({ disableSkillShellExecution: value })).toBe(false)
      expect(getWorkspaceActions({ ...config, disableSkillShellExecution: value }, 'darwin')).toHaveLength(1)
    }
  })

  test('a config with no actions key is empty rather than an error', () => {
    expect(getWorkspaceActions({}, 'darwin')).toEqual([])
    expect(getWorkspaceActions(null, 'darwin')).toEqual([])
  })

  test('a MALFORMED list still throws through the read — it is not swallowed', () => {
    // The boundary between "no actions" and "a declaration nobody parsed": a
    // read that returned `[]` for a broken list would hide the mistake behind
    // the same answer an empty config gives.
    expect(() => getWorkspaceActions({ [WORKSPACE_ACTIONS_SETTING_KEY]: [action({ command: {} })] }, 'darwin'))
      .toThrow()
  })
})

describe('P6.720 — the cwd is contained again at RUN, not only at declaration', () => {
  // `/tmp` rather than a real project: this rule is pure path arithmetic and
  // touches no filesystem, which is also why it is safe to assert on Windows-ish
  // inputs from a posix host — `resolve` is the same function either way.
  const ROOT = '/tmp/w8z-project'

  test('a declared subdirectory resolves under the session root', () => {
    expect(resolveWorkspaceActionCwd(ROOT, 'apps/web')).toBe('/tmp/w8z-project/apps/web')
    // A trailing-dot form and surrounding space resolve to the same place: the
    // check is on the resolved path, so the caller cannot smuggle a difference
    // past it with formatting.
    expect(resolveWorkspaceActionCwd(ROOT, '  apps/web/.  ')).toBe('/tmp/w8z-project/apps/web')
  })

  test('no declaration is no change — the control', () => {
    // The whole point of the fallback arm: an action that says nothing must run
    // exactly where it runs today, and `undefined` is how the caller says so.
    expect(resolveWorkspaceActionCwd(ROOT, undefined)).toBeUndefined()
  })

  test('the root itself is inside the root', () => {
    expect(resolveWorkspaceActionCwd(ROOT, '.')).toBe('/tmp/w8z-project')
  })

  test('a path that ESCAPES is refused BY NAME, never silently ignored', () => {
    // Refuses rather than falling back, and the message names the value: a
    // command that quietly runs somewhere other than where it was told to is
    // the accepted-and-ignored shape this row removes.
    expect(() => resolveWorkspaceActionCwd(ROOT, '../elsewhere')).toThrow(/must be within the workspace root/)
    expect(() => resolveWorkspaceActionCwd(ROOT, 'apps/../../elsewhere')).toThrow(/must be within the workspace root/)
    expect(() => resolveWorkspaceActionCwd(ROOT, '/etc')).toThrow(/must be within the workspace root/)
  })

  test('a sibling whose name merely STARTS with the root is outside it', () => {
    // The separator in the prefix test is what makes this false rather than
    // true: `/tmp/w8z-project-evil` starts with `/tmp/w8z-project`.
    expect(() => resolveWorkspaceActionCwd(ROOT, '../w8z-project-evil')).toThrow(/must be within the workspace root/)
  })

  test('blank and NUL are refused by their own words', () => {
    expect(() => resolveWorkspaceActionCwd(ROOT, '   ')).toThrow(/non-empty string/)
    expect(() => resolveWorkspaceActionCwd(ROOT, 'apps/' + '\u0000')).toThrow(/NUL byte/)
  })
})
