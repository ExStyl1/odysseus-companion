/**
 * C3.369 — a codex shell and the host's proxy.
 *
 * ## The row's premise, and the half of it the SOURCE refutes
 *
 * R6b measured `envSeen: []` inside a codex shell against claude's seven names
 * in the same run, and the row read that as *"a codex shell sees NONE of the
 * proxy variables the host projects"*. Read at `rust-v0.150.1` (strong tier —
 * source), that is not what codex does:
 *
 *  - `codex-rs/protocol/src/config_types.rs` declares
 *    `ShellEnvironmentPolicyInherit` with `#[default]` on **`All`**, not on
 *    `Core`, and `impl Default for ShellEnvironmentPolicy` pairs it with
 *    `ignore_default_excludes: true`. So with no `[shell_environment_policy]`
 *    narrowing it, codex hands a shell command the WHOLE parent environment and
 *    applies none of the `*KEY*` / `*SECRET*` / `*TOKEN*` default excludes.
 *  - `CodexRuntimeManager.spawn` spreads `process.env`, and its own docblock
 *    says so: *"a `HTTPS_PROXY` exported in a corporate user's `.zshrc` reaches
 *    codex whether or not anything here projects it."*
 *
 * So an AMBIENT proxy already reached a codex shell. What never reached it is a
 * proxy the user configured in the app's Settings — which lives in the stored
 * config and in no environment at all, and is exactly where claude's seven names
 * came from (`agent/options.ts` projects `getProxyEnvVars()` for that child).
 *
 * ## What is pinned here
 *
 * The seam is a spread inside a spawn literal in a private method that needs an
 * app-server subprocess to reach, so the WIRING is asserted against the source —
 * the instrument `additional-directories.test.ts` uses on the same file for the
 * same reason — and the VALUE is asserted by driving the helper the way codex
 * calls it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildShellChildNetworkEnv } from '../../config/proxy-env.ts';
import type { NetworkProxySettings } from '../../config/types.ts';

const SETTINGS_PROXY: NetworkProxySettings = {
  enabled: true,
  httpProxy: 'http://proxy.corp.example:3128',
  httpsProxy: 'http://proxy.corp.example:3128',
};

describe('C3.369 — the codex child carries the Settings proxy', () => {
  it('WIRING — the spawn literal spreads the shared shell-child network env', () => {
    // The regression this guards is the spread being dropped, which is silent:
    // the child still starts, the turn still runs on loopback, and only a shell
    // command behind a corporate proxy fails — on someone else's machine.
    const source = readFileSync(new URL('../codex-agent.ts', import.meta.url), 'utf-8');
    expect(source).toMatch(/\.\.\.buildShellChildNetworkEnv\(\),/);
    // Two positive controls the anchor needs. The spread is worthless unless it
    // lands in the object handed to `manager.spawn`, and unless the loopback
    // exemption still runs over the merged result — without that second one the
    // projection is the REGRESSION `runtime-manager.ts`'s docblock warned about,
    // because codex would POST its own loopback model traffic at the proxy.
    expect(source).toMatch(/const child = manager\.spawn\(\{/);
    expect(readFileSync(
      new URL('../../../../codex-agent-server/src/runtime-manager.ts', import.meta.url),
      'utf-8',
    )).toMatch(/applyLoopbackNoProxy\(env\);/);
  });

  it('POSITIVE — a Settings-only proxy reaches the child env, in both spellings', async () => {
    // The measured case: nothing in the environment, the proxy configured in the
    // app. This is what produced `envSeen: []` and what the row closes.
    const env = buildShellChildNetworkEnv({ processEnv: {}, settings: SETTINGS_PROXY });

    expect(env.HTTPS_PROXY).toBe('http://proxy.corp.example:3128');
    expect(env.https_proxy).toBe('http://proxy.corp.example:3128');
    expect(env.HTTP_PROXY).toBe('http://proxy.corp.example:3128');
    // And loopback is exempted in the same object, which is the condition
    // `runtime-manager.ts` set before it would accept this projection at all.
    expect(env.NO_PROXY).toContain('127.0.0.1');
  });

  it('BOUNDARY — with no proxy anywhere the spread is empty, so the codex env is byte-identical', () => {
    // The bound that makes this safe to ship: a machine without a proxy must see
    // no change at all in what the codex binary is launched with.
    expect(buildShellChildNetworkEnv({ processEnv: {}, settings: undefined })).toEqual({});
  });

  it('CONTROL — an ambient proxy is carried too, so the projection never REPLACES the inherited one', () => {
    // The refuted half of the premise, kept as a live control: an exported
    // proxy already reached codex through the `process.env` spread, and this
    // row must not have made that case worse. Settings wins where both exist —
    // the precedence `buildPiSubprocessEnv` already gives them — and the
    // ambient-only case still yields the ambient value.
    const ambientOnly = buildShellChildNetworkEnv({
      processEnv: { HTTPS_PROXY: 'http://ambient.example:8080' },
      settings: undefined,
    });
    expect(ambientOnly.HTTPS_PROXY).toBe('http://ambient.example:8080');

    const both = buildShellChildNetworkEnv({
      processEnv: { HTTPS_PROXY: 'http://ambient.example:8080' },
      settings: SETTINGS_PROXY,
    });
    expect(both.HTTPS_PROXY).toBe('http://proxy.corp.example:3128');
  });
});
