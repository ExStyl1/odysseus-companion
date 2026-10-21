/**
 * P2.396 — a managed MCP policy entry expands from a PINNED environment, and
 * the server's configured value does not.
 *
 * `managed-mcp.md#how-policy-entries-expand` (anchor read off the rendered page
 * with `curl` and a grep for `id="…"`, alongside `#how-a-server-is-evaluated`
 * and `#match-servers-by-url-command-or-name` as positive controls on the same
 * fetch) opens with the split this file exists to hold:
 *
 *   "The server's configured value expands from the live process environment,
 *   like the rest of `.mcp.json`. A policy entry expands from a pinned
 *   environment instead, so a variable set by a project or user settings file
 *   can't change what an allowlist entry means."
 *
 * and its table names the pinned environment for both lists — `allowedMcpServers`
 * expands from "The environment Claude Code started with, plus `env` values from
 * managed settings", `deniedMcpServers` from "The same, and a variable with no
 * startup value and no `:-default` fills from settings files outside the
 * repository, such as user or managed settings, which only ever widens what the
 * entry matches". It closes "Requires Claude Code v2.1.219 or later."
 *
 * We expanded BOTH sides through the live `process.env`. The tests below are
 * the two halves of the correction, and they pull in OPPOSITE directions on
 * purpose — pinning both sides would be the obvious fix and is a fail-OPEN one.
 *
 * ## `serverCommand` is the fixture, not `serverUrl`, and that is deliberate
 *
 * P2.375 already neutralises a variable inside a `serverUrl` entry on both
 * lists, so on that field a mid-session mutation cannot move a verdict whether
 * the environment is pinned or not. `serverCommand` is untouched by those
 * guards — the page's column names "a URL entry's scheme, host, or path scope"
 * and nothing else — so it is where the live environment was still deciding
 * what an administrator's policy meant.
 */
import { describe, expect, test } from 'bun:test'
import {
  isManagedMcpServerAllowed,
  parseManagedPiPolicyV1,
  type ManagedMcpServerIdentityV1,
  type ManagedPiPolicyV1,
} from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import {
  assertNoHomeOrRootPath,
  GateSafetyRefusal,
} from '../../../../../scripts/gate-safety.ts'
import {
  managedPolicyExpansionEnvironment,
  startupEnvironment,
} from '../startup-environment.ts'

/* ------------------------------------------------------------------------- *
 * The refusal harness
 *
 * An environment-expansion test is worthless with toy values: `${TOOLS_DIR}`
 * pointing at `x` proves nothing about a policy an administrator would write.
 * So the fixtures below name a home-shaped absolute path on purpose — and that
 * makes the boundary worth stating mechanically rather than trusting.
 *
 * `MATCHER_ONLY` is the assertion that these strings are DATA. Every one of
 * them is handed to a matcher and to nothing else; the harness proves that if
 * one ever reached an executor it would be refused there, using this repo's own
 * gate-runner guard rather than a second copy of the rule.
 * ------------------------------------------------------------------------- */

/**
 * Assert that `value` would be REFUSED by the gate runners' executor guard —
 * i.e. that it can only ever be matcher input.
 */
function MATCHER_ONLY(value: string): string {
  expect(() => assertNoHomeOrRootPath('a P2.396 fixture', value)).toThrow(GateSafetyRefusal)
  return value
}

/** Where the administrator's tools live when the policy is written. */
const TOOLS_AT_STARTUP = MATCHER_ONLY('/Users/corp-admin/vetted')
/** Where a user points the same variable, mid-session, to walk past the policy. */
const TOOLS_AFTER_MUTATION = MATCHER_ONLY('/Users/corp-admin/anything-else')

const VETTED_SERVER = MATCHER_ONLY(`${TOOLS_AT_STARTUP}/bin/server`)
const OTHER_SERVER = MATCHER_ONLY(`${TOOLS_AFTER_MUTATION}/bin/server`)

/** The entry as the administrator wrote it. Not a path — a policy pattern. */
const TOOLS_ENTRY = '${TOOLS_DIR}/bin/server'

const lists = (extra: Record<string, unknown>): ManagedPiPolicyV1 => parseManagedPiPolicyV1({
  schemaVersion: 1,
  disabledPermissionModes: [],
  ...extra,
})

const STDIO = (command: readonly string[]): ManagedMcpServerIdentityV1 => ({
  name: 'tool',
  transport: 'stdio',
  command,
})

describe('the refusal harness itself', () => {
  test('refuses a home-shaped fixture and accepts a repo-relative control', () => {
    // Self-test, both directions: a harness that never fires and a harness that
    // always fires look identical from the tests that use it.
    expect(() => MATCHER_ONLY(TOOLS_AT_STARTUP)).not.toThrow()
    // The positive control — a repo-relative string is what the gate runners
    // actually execute, and it must NOT be refused, so `MATCHER_ONLY` fails on
    // it. That is the assertion that the guard discriminates.
    expect(() => MATCHER_ONLY('packages/server-core')).toThrow()
    expect(() => assertNoHomeOrRootPath('control', 'packages/server-core')).not.toThrow()
  })
})

describe('P2.396 — the policy entry expands from the pinned environment', () => {
  test('a variable mutated mid-session does not move a verdict', () => {
    const policy = lists({ deniedMcpServers: [{ serverCommand: [TOOLS_ENTRY] }] })
    const startup = { TOOLS_DIR: TOOLS_AT_STARTUP }
    // The LIVE environment, mutated after startup — a `.env` a project loads, a
    // shell export inherited by a later child, an `export` in a hook.
    const live = { TOOLS_DIR: TOOLS_AFTER_MUTATION }
    const denied = STDIO([VETTED_SERVER])

    // Pinned: the entry still means what the administrator wrote.
    expect(isManagedMcpServerAllowed(policy, denied, live, {
      policyEnvironment: startup,
    })).toBe(false)

    // And the same policy under the SAME mutation with no pin is the defect
    // this row closes: the deny evaporates. Asserted rather than described, so
    // that a future change which quietly re-reads the live environment for the
    // entry cannot pass this file.
    expect(isManagedMcpServerAllowed(policy, denied, live)).toBe(true)
  })

  test('the mutation cannot widen an allowlist either', () => {
    const policy = lists({ allowedMcpServers: [{ serverCommand: [TOOLS_ENTRY] }] })
    const startup = { TOOLS_DIR: TOOLS_AT_STARTUP }
    const live = { TOOLS_DIR: TOOLS_AFTER_MUTATION }

    // The grant covers what it covered at startup…
    expect(isManagedMcpServerAllowed(policy, STDIO([VETTED_SERVER]), live, {
      policyEnvironment: startup,
    })).toBe(true)
    // …and not what a mid-session value would have pointed it at.
    expect(isManagedMcpServerAllowed(policy, STDIO([OTHER_SERVER]), live, {
      policyEnvironment: startup,
    })).toBe(false)
    // Unpinned, the mutation moves the grant onto the other binary — the
    // widening direction, which is the worse of the two.
    expect(isManagedMcpServerAllowed(policy, STDIO([OTHER_SERVER]), live)).toBe(true)
  })

  test('the SERVER\'s configured value still reads the LIVE environment', () => {
    // The other half of the split, and the reason pinning both sides would be a
    // regression rather than a stricter fix. Here the ENTRY is literal — the
    // resolution the page prescribes — and the SERVER references the variable.
    // Its real command at spawn time is whatever the live environment says, so
    // judging it on the startup value would let it slip the deny.
    const policy = lists({ deniedMcpServers: [{ serverCommand: [OTHER_SERVER] }] })
    const startup = { TOOLS_DIR: TOOLS_AT_STARTUP }
    const live = { TOOLS_DIR: TOOLS_AFTER_MUTATION }

    expect(isManagedMcpServerAllowed(policy, STDIO([TOOLS_ENTRY]), live, {
      policyEnvironment: startup,
    })).toBe(false)
  })

  test('a literal entry is unaffected, pinned or not', () => {
    // The control the whole design rests on: an administrator who followed the
    // page's own advice — "use literal URLs and commands for entries you rely
    // on for enforcement" — sees no behaviour change at all.
    const policy = lists({ deniedMcpServers: [{ serverCommand: [VETTED_SERVER] }] })
    const startup = { TOOLS_DIR: TOOLS_AT_STARTUP }
    const live = { TOOLS_DIR: TOOLS_AFTER_MUTATION }

    expect(isManagedMcpServerAllowed(policy, STDIO([VETTED_SERVER]), live, {
      policyEnvironment: startup,
    })).toBe(false)
    expect(isManagedMcpServerAllowed(policy, STDIO([VETTED_SERVER]), live)).toBe(false)
    expect(isManagedMcpServerAllowed(policy, STDIO([OTHER_SERVER]), live, {
      policyEnvironment: startup,
    })).toBe(true)
  })

  test('`serverName` never expands, on either environment', () => {
    // `#match-servers-by-url-command-or-name` — "`serverName` values match
    // literally and never expand." The pinned path must not have introduced an
    // expansion the live path never had.
    const policy = lists({ deniedMcpServers: [{ serverName: 'toolsdir' }] })
    const startup = { TOOLS_DIR: TOOLS_AT_STARTUP, toolsdir: 'other' }

    expect(isManagedMcpServerAllowed(policy, { name: 'toolsdir' }, {}, {
      policyEnvironment: startup,
    })).toBe(false)
    expect(isManagedMcpServerAllowed(policy, { name: 'other' }, {}, {
      policyEnvironment: startup,
    })).toBe(true)
  })
})

describe('the startup snapshot', () => {
  const PROBE = 'NESSY_P2396_PROBE'

  test('is a copy, so a later mutation of the process environment cannot reach it', () => {
    // `process.env` is a live object. Holding a REFERENCE to it would pin
    // nothing, and would look exactly like this module working.
    expect(startupEnvironment()[PROBE]).toBeUndefined()
    try {
      process.env[PROBE] = 'set-after-startup'
      expect(process.env[PROBE]).toBe('set-after-startup')
      expect(startupEnvironment()[PROBE]).toBeUndefined()
    } finally {
      delete process.env[PROBE]
    }
  })

  test('the managed `env` block is layered on top of it', () => {
    // The page's sentence, assembled: "The environment Claude Code started
    // with, plus `env` values from managed settings".
    const composed = managedPolicyExpansionEnvironment({ [PROBE]: 'from-managed-settings' })
    expect(composed[PROBE]).toBe('from-managed-settings')
    // …without disturbing the snapshot every other caller shares.
    expect(startupEnvironment()[PROBE]).toBeUndefined()
    // An empty or absent block returns the snapshot itself rather than a copy
    // of it: identity is the cheapest way to say "nothing was layered".
    expect(managedPolicyExpansionEnvironment(undefined)).toBe(startupEnvironment())
    expect(managedPolicyExpansionEnvironment({})).toBe(startupEnvironment())
  })
})
