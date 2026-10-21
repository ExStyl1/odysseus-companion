/**
 * A7 — the built-in dp-backed MCP set.
 *
 * Every arm injects `resolveDpPath`, so nothing here depends on the host having
 * `dp`, and nothing here executes it. The one arm that would be host-dependent
 * — "dp is missing" — is exactly the arm that must not need a machine without
 * dp to run, which is why the lookup is a seam.
 *
 * The contract changed on 2026-08-01 by owner decision: the WHOLE `dp ai mcp`
 * set is embedded and EVERY entry defaults to disabled — "вшить весь базовый
 * набор но по дефолту выключен, юзер сам решит что ему включать". Two
 * consequences shape the arms below.
 *
 * 1. Nothing arrives on its own, so an arm that needs a built-in present
 *    switches it on by name. The six that were briefly default-on (`codeSearch`,
 *    `dpGitlab`, `dpJira`, `dpMR`, `dpSage`, `dpWiki`) have no special status
 *    left; naming one here is a choice of specimen, not a default being read.
 * 2. A default materialization is EMPTY, and that emptiness is what lets the
 *    pool fold the set unconditionally while thirteen exact-map assertions in
 *    four other files stay green. It is pinned as its own arm rather than left
 *    to be inferred.
 */

import { describe, expect, it, test } from 'bun:test';
import { sanitizeMcpNameSegment } from '../../capabilities/mcp-wire-name.ts';
import {
  BUILTIN_DP_MCP_EXCLUSIONS,
  BUILTIN_DP_MCP_SERVERS,
  DP_AI_MCP_SUBCOMMANDS,
  isBuiltinDpMcpServerEnabled,
  materializeBuiltinDpMcpServers,
  mergeBuiltinDpMcpServers,
} from '../builtin-dp-servers.ts';

const DP = '/usr/local/bin/dp';
const dpPresent = () => DP;
const dpMissing = () => null;
const ALL_NAMES = BUILTIN_DP_MCP_SERVERS.map(definition => definition.name);

describe('the built-in dp MCP set enumerates', () => {
  it('materializes the servers switched on as `dp ai mcp <sub>` stdio commands', () => {
    const { available, servers, disabledServers, diagnostics } =
      materializeBuiltinDpMcpServers({
        resolveDpPath: dpPresent,
        enabled: { dpGitlab: true, dpMR: true },
        runtimeEnv: {},
      });

    expect(available).toBe(true);
    expect(diagnostics).toEqual([]);
    expect(Object.keys(servers).sort()).toEqual(['dpGitlab', 'dpMR']);
    expect(servers.dpGitlab).toEqual({ type: 'stdio', command: DP, args: ['ai', 'mcp', 'gitlab'] });
    // The catalogue name and the dp subcommand differ for most of the set; the
    // merge-request one is the pair most likely to be "simplified" into a bug.
    expect(servers.dpMR).toEqual({ type: 'stdio', command: DP, args: ['ai', 'mcp', 'merge-request'] });
    // Everything else is REPORTED off, not silently missing.
    expect(disabledServers).toContain('dpMail');
    expect(servers.dpMail).toBeUndefined();
    expect(disabledServers).toHaveLength(BUILTIN_DP_MCP_SERVERS.length - 2);
  });

  it('defaults every entry to disabled, so the embedded set starts nothing on its own', () => {
    // The owner decision, stated where a change to it must break. Embedding all
    // twenty-eight is only safe because none of them runs unasked: one `true`
    // here is one more stdio subprocess per session pool AND per browse pool, in
    // every workspace, before any preference exists that could stop it.
    for (const definition of BUILTIN_DP_MCP_SERVERS) {
      expect(definition.defaultEnabled).toBe(false);
      expect(isBuiltinDpMcpServerEnabled(definition.name)).toBe(false);
    }

    const { available, servers, disabledServers } =
      materializeBuiltinDpMcpServers({ resolveDpPath: dpPresent });

    // dp is stipulated PRESENT and the materializer still yields nothing, so the
    // empty map is the default rather than a missing binary — and the assertion
    // is the same on a CI box, which has no dp, as on a developer machine.
    expect(available).toBe(true);
    expect(servers).toEqual({});
    expect(disabledServers).toEqual(ALL_NAMES);
  });

  it('runs no server dp cannot serve, embeds every one it can, and carries none of the four excluded names', () => {
    const subcommands = BUILTIN_DP_MCP_SERVERS.map(definition => definition.subcommand);
    for (const definition of BUILTIN_DP_MCP_SERVERS) {
      expect(DP_AI_MCP_SUBCOMMANDS).toContain(definition.subcommand);
    }
    // One wire name is one server and one dp subcommand is one wire name: a
    // duplicate on either side is two subprocesses serving identical tools.
    expect(new Set(ALL_NAMES).size).toBe(ALL_NAMES.length);
    expect(new Set(subcommands).size).toBe(subcommands.length);

    const excluded = BUILTIN_DP_MCP_EXCLUSIONS.map(entry => entry.name);
    for (const entry of BUILTIN_DP_MCP_EXCLUSIONS) {
      expect(ALL_NAMES).not.toContain(entry.name);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    // `remote` joined the list with the embed-everything decision: it is a proxy
    // that needs `--url`, so it is the one subcommand that cannot be a
    // zero-configuration entry.
    expect([...excluded].sort()).toEqual(['context7', 'meetings', 'remote', 'whiteboard']);

    // "вшить весь базовый набор" — the whole set dp serves is embedded. The only
    // subcommands allowed to have no built-in are `info`, which is not a server,
    // and the ones the exclusions name AND explain. Re-running `dp ai mcp --help`
    // and extending `DP_AI_MCP_SUBCOMMANDS` without wiring the new subcommand
    // fails here, which is the point: the coverage is the decision.
    const covered = new Set(subcommands);
    const excludedNames = new Set(excluded);
    expect(DP_AI_MCP_SUBCOMMANDS.filter(
      subcommand => subcommand !== 'info' && !covered.has(subcommand) && !excludedNames.has(subcommand),
    )).toEqual([]);
  });

  it("names every server within the mint's 40-char cap AND inside its sanitizer's alphabet, so a built-in wire name is never renamed", () => {
    // Positive control for the 2026-08-10 field incident this plan fixes, and
    // for the review finding (task 2) that closed the gap: this module's
    // `materializeBuiltinDpMcpServers` keys the pool by `definition.name`
    // VERBATIM, and the resolver's collision policy now runs every
    // scoped/native wire name through
    // `capMcpNameSegment(sanitizeMcpNameSegment(name), 40)` at the mint
    // (`capabilities/resolver.ts`'s `applyCollisionPolicy`). BOTH halves of
    // that mint can rename a built-in behind the pool's back, and either one
    // reproduces the original incident's "seed and pool disagree" shape: a
    // name over 40 chars gets a silent hash tail, and a name carrying any
    // character outside `[A-Za-z0-9_-]` — a dot, a space — comes back rewritten
    // by the sanitizer. The cap was pinned when the mint only capped; the
    // sanitizer assertion below is the same guard for the half added on
    // 2026-08-11. This test keeps both impossible by construction.
    for (const definition of BUILTIN_DP_MCP_SERVERS) {
      expect(definition.name.length).toBeLessThanOrEqual(40);
      expect(sanitizeMcpNameSegment(definition.name)).toBe(definition.name);
    }
  });
});

describe('each server is switchable on its own', () => {
  it('withholds a server the user switched off while its neighbour stays on', () => {
    const enabled = { dpJira: false, dpGitlab: true };
    const { servers, disabledServers } = materializeBuiltinDpMcpServers({
      resolveDpPath: dpPresent,
      enabled,
    });

    expect(servers.dpJira).toBeUndefined();
    expect(disabledServers).toContain('dpJira');
    // Only the named server moves — a switch that took the set with it would be
    // indistinguishable from a broken set, and with every entry now off by
    // default that is the easy failure to miss.
    expect(servers.dpGitlab).toBeDefined();
    expect(isBuiltinDpMcpServerEnabled('dpJira', enabled)).toBe(false);
    expect(isBuiltinDpMcpServerEnabled('dpGitlab', enabled)).toBe(true);
  });

  it('yields exactly the server the preference asked for, and no other', () => {
    const { servers, disabledServers } = materializeBuiltinDpMcpServers({
      resolveDpPath: dpPresent,
      enabled: { dpMail: true },
      runtimeEnv: {},
    });

    // Opting one in opts in ONE. An `enabled` record that admitted its
    // neighbours — or that read as "the user has expressed a preference, so run
    // the set" — would be invisible from any arm that only checks the named
    // server is present.
    expect(Object.keys(servers)).toEqual(['dpMail']);
    expect(servers.dpMail).toEqual({ type: 'stdio', command: DP, args: ['ai', 'mcp', 'mail'] });
    expect(disabledServers).not.toContain('dpMail');
    expect(disabledServers).toHaveLength(BUILTIN_DP_MCP_SERVERS.length - 1);
    expect(disabledServers).toContain('dpGitlab');
  });

  it('ignores a name it does not know and leaves every unnamed server at its own default', () => {
    // Forward compatibility, in both directions.
    //
    // A preference file written by a LATER release can name a server this build
    // has never heard of, and a file written by an EARLIER one cannot mention a
    // server this build just added. The first is ignored rather than an error;
    // the second falls back to the definition's own `defaultEnabled` — false for
    // all of them — so shipping a new built-in can never silently start a
    // subprocess on the first launch after an upgrade.
    const stored = { whiteboard: true, context7: true, dpNotInThisRelease: true, dpMail: true };
    const { servers, disabledServers } = materializeBuiltinDpMcpServers({
      resolveDpPath: dpPresent,
      enabled: stored,
    });

    expect(servers.whiteboard).toBeUndefined();
    expect(servers.context7).toBeUndefined();
    expect(servers.dpNotInThisRelease).toBeUndefined();
    expect(isBuiltinDpMcpServerEnabled('dpNotInThisRelease', stored)).toBe(false);
    // The known name in the SAME record is still honoured, so "ignored" is about
    // the unknown names and not about a record the materializer failed to read.
    expect(Object.keys(servers)).toEqual(['dpMail']);
    // Every server the record does not mention is off by its own default.
    expect(disabledServers).toEqual(ALL_NAMES.filter(name => name !== 'dpMail'));
  });
});

describe('a machine without dp degrades instead of failing', () => {
  it('reports the set unavailable with a diagnostic that names dp', () => {
    const enabled = { dpGitlab: true };
    const result = materializeBuiltinDpMcpServers({ resolveDpPath: dpMissing, enabled });

    expect(result.available).toBe(false);
    expect(result.servers).toEqual({});
    // "Disabled" keeps meaning "switched off", never "unavailable": a server the
    // user asked for is missing from `servers` and still absent from
    // `disabledServers`, so the UI can tell the two states apart.
    expect(result.disabledServers).not.toContain('dpGitlab');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe('builtin_dp_mcp.dp_not_found');
    expect(result.diagnostics[0]!.message).toContain('dp');
    // Positive control for the absence: the SAME call with the SAME preference
    // and dp present does produce that server and no diagnostic, so the empty
    // map above is dp's absence and not the set's off-by-default state.
    const control = materializeBuiltinDpMcpServers({ resolveDpPath: dpPresent, enabled });
    expect(Object.keys(control.servers)).toEqual(['dpGitlab']);
    expect(control.diagnostics).toEqual([]);
  });

  it('never throws on the default lookup, and starts nothing, whichever machine runs it', () => {
    // The production entry point takes no resolver. `resolveDpBinary` THROWS
    // `DpNotFound`, so the one thing this must prove on a CI box without dp is
    // that the throw is absorbed. This is the only arm that consults the real
    // PATH, and it is deliberate: absorbing that throw is the behaviour under
    // test. Nothing is executed — `resolveDpBinary` is an `accessSync` scan.
    //
    // Both halves are host-INDEPENDENT: no preference is passed, so a machine
    // WITH dp materializes an empty set for a different reason than a machine
    // without one, and the assertion is the same either way.
    const result = materializeBuiltinDpMcpServers();

    expect(typeof result.available).toBe('boolean');
    expect(result.servers).toEqual({});
    expect(result.disabledServers).toEqual(ALL_NAMES);
    if (result.available) {
      expect(result.diagnostics).toEqual([]);
    } else {
      expect(result.diagnostics[0]!.code).toBe('builtin_dp_mcp.dp_not_found');
    }
  });
});

describe('a built-in name never displaces the user own server', () => {
  // Both arms below switch their specimens on: with every entry off by default
  // the built-in map is empty, and a fold with nothing in it cannot reach either
  // stand-down rule at all.
  const foldable = { dpGitlab: true, dpJira: true };

  it('yields the wire name and says so, rather than throwing a collision', () => {
    const mine = { dpGitlab: { type: 'stdio' as const, command: '/opt/mine', args: [] } };
    const { servers } = materializeBuiltinDpMcpServers({ resolveDpPath: dpPresent, enabled: foldable, runtimeEnv: {} });
    const merged = mergeBuiltinDpMcpServers(mine, servers);

    expect(merged.servers.dpGitlab).toBe(mine.dpGitlab);
    expect(merged.servers.dpJira).toEqual({ type: 'stdio', command: DP, args: ['ai', 'mcp', 'jira'] });
    expect(merged.diagnostics).toHaveLength(1);
    expect(merged.diagnostics[0]!.code).toBe('builtin_dp_mcp.wire_name_taken');
    expect(merged.diagnostics[0]!.servers).toEqual(['dpGitlab']);
  });

  it('stands down when the same dp subcommand already runs under another name', () => {
    // The installed `nessy-default-extension` shape: its own wire names, the
    // same `dp ai mcp <sub>` behind them. Matched on the argv TAIL, because a
    // plugin-declared dp server arrives with its command rewritten to the
    // supervised host executable — a `command === 'dp'` test would see none of
    // these.
    const extension = {
      jira: { type: 'stdio' as const, command: '/opt/nessy/runtime/dp', args: ['ai', 'mcp', 'jira'] },
    };
    const { servers } = materializeBuiltinDpMcpServers({ resolveDpPath: dpPresent, enabled: foldable, runtimeEnv: {} });
    const merged = mergeBuiltinDpMcpServers(extension, servers);

    expect(merged.servers.jira).toBe(extension.jira);
    expect(merged.servers.dpJira).toBeUndefined();
    // Positive control: only the duplicated subcommand stands down — the other
    // server the user switched on is still folded in, so an absent `dpJira` is
    // the rule and not a merge that dropped everything.
    expect(merged.servers.dpGitlab).toEqual({ type: 'stdio', command: DP, args: ['ai', 'mcp', 'gitlab'] });
    expect(merged.diagnostics).toHaveLength(1);
    expect(merged.diagnostics[0]!.code).toBe('builtin_dp_mcp.subcommand_taken');
    expect(merged.diagnostics[0]!.servers).toEqual(['dpJira']);
    expect(merged.diagnostics[0]!.message).toContain('jira');
  });
});

test('materialized servers carry an injected runtime env verbatim', () => {
  const result = materializeBuiltinDpMcpServers({
    enabled: { dpGitlab: true },
    resolveDpPath: () => '/fake/dp',
    runtimeEnv: { DP_NO_WARNINGS: 'true' },
  });
  expect(result.servers['dpGitlab']).toEqual({
    type: 'stdio',
    command: '/fake/dp',
    args: ['ai', 'mcp', 'gitlab'],
    env: { DP_NO_WARNINGS: 'true' },
  });
});

test('an empty injected env keeps the config byte-identical to the pre-env shape', () => {
  const result = materializeBuiltinDpMcpServers({
    enabled: { dpGitlab: true },
    resolveDpPath: () => '/fake/dp',
    runtimeEnv: {},
  });
  expect(result.servers['dpGitlab']).toEqual({
    type: 'stdio',
    command: '/fake/dp',
    args: ['ai', 'mcp', 'gitlab'],
  });
});

test('the default env is the dp runtime environment (keys only — value is host state)', () => {
  const result = materializeBuiltinDpMcpServers({
    enabled: { dpGitlab: true },
    resolveDpPath: () => '/fake/dp',
  });
  // Narrowed via a cast rather than `server.type === 'stdio'`: only the stdio
  // arm of `SdkMcpServerConfig` carries `env`, and every server this module
  // produces is stdio by construction (see `materializeBuiltinDpMcpServers`).
  const dpGitlab = result.servers['dpGitlab'] as { env?: Record<string, string> } | undefined;
  expect(Object.keys(dpGitlab!.env ?? {}))
    .toEqual(expect.arrayContaining(['HOME', 'DP_NO_WARNINGS', 'DP_AI_MCP_SKIP_LOGIN']));
});
