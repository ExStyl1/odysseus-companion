/**
 * P2.259 — the loopback NO_PROXY exemption on the Pi subprocess env.
 *
 * The third runtime with this shape (P2.213 codex, P2.251 claude) and the only
 * one whose failing state is a shipped DEFAULT: the local-model card's endpoint
 * placeholder is `http://localhost:11434`, so a corporate-proxy user's Ollama
 * session is in the broken arm by construction.
 *
 * Measured 2026-08-27, six arms against the real bundled `pi-agent-server` with
 * the real interceptor preloaded, behind a locally built sink proxy and a local
 * OpenAI-compatible stub, three independent detectors: with a proxy in the
 * ambient env and no exemption the turn FAILS, the stub gets 0 hits, and the
 * sink gets `POST http://localhost:<port>/v1/chat/completions`.
 *
 * Two arms decided WHERE the rule goes, and neither could be reached by reading:
 *   - the interceptor's own `shouldBypassProxy` is NOT authoritative — Bun's
 *     native fetch reads the proxy vars at launch, so a bypass decision
 *     that merely omits `init.proxy` is overridden. The env is the only lever.
 *   - Bun reads `no_proxy` BEFORE `NO_PROXY`, the opposite of the interceptor's
 *     own `NO_PROXY || no_proxy`. An uppercase-only exemption is silently lost
 *     to a shell that exports the lowercase spelling.
 */
import { describe, expect, it } from 'bun:test';
import { buildPiSubprocessEnv } from '../pi-agent.ts';

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

/**
 * The spawn site's own arguments, minus the proxy sources each case supplies.
 * `proxyEnv` is passed explicitly rather than read from storage, so no case
 * depends on the machine's stored network settings.
 */
function parts(overrides: {
  processEnv?: NodeJS.ProcessEnv;
  proxyEnv?: Record<string, string>;
  envOverrides?: Record<string, string>;
} = {}) {
  return {
    processEnv: overrides.processEnv ?? {},
    proxyEnv: overrides.proxyEnv ?? {},
    ...(overrides.envOverrides ? { envOverrides: overrides.envOverrides } : {}),
    awsEnv: {},
    sessionId: 'p2259-session',
    debug: false,
  };
}

describe('P2.259 loopback proxy exemption on the Pi subprocess env', () => {
  it('exempts loopback when the host SHELL alone carries a proxy', () => {
    // The failing arm as measured: no Settings proxy at all, a HTTPS_PROXY
    // inherited from the login shell (`loadShellEnv` copies it in wholesale on
    // macOS packaged builds). A rule inside `buildNetworkEnvVars` would see
    // nothing here, which is why it lives over the merged env instead.
    const env = buildPiSubprocessEnv(parts({
      processEnv: { HTTPS_PROXY: 'http://proxy.corp.invalid:3128' },
    }));

    const entries = (env.NO_PROXY ?? '').split(',');
    for (const host of LOOPBACK) expect(entries).toContain(host);
    // Not an opt-out: a wildcard would pass the measured arm while sending
    // every corporate request direct.
    expect(entries).not.toContain('*');
  });

  it('writes the lowercase spelling too — the one Bun reads FIRST', () => {
    const env = buildPiSubprocessEnv(parts({
      processEnv: { HTTPS_PROXY: 'http://proxy.corp.invalid:3128' },
    }));

    expect(env.no_proxy).toBe(env.NO_PROXY);
    expect((env.no_proxy ?? '').split(',')).toContain('localhost');
  });

  it('covers the shipped local-model default host, not just the numeric form', () => {
    // `onboarding.localModel.endpointPlaceholder` is `http://localhost:11434`.
    // An exemption listing only `127.0.0.1` would leave the default card broken.
    const env = buildPiSubprocessEnv(parts({
      processEnv: { http_proxy: 'http://proxy.corp.invalid:3128' },
    }));

    expect(new URL('http://localhost:11434').hostname).toBe('localhost');
    expect((env.no_proxy ?? '').split(',')).toContain('localhost');
  });

  it('fires on the Settings projection as well as the ambient env', () => {
    const env = buildPiSubprocessEnv(parts({
      proxyEnv: { HTTP_PROXY: 'http://proxy.corp.invalid:3128', http_proxy: 'http://proxy.corp.invalid:3128' },
    }));

    expect((env.NO_PROXY ?? '').split(',')).toContain('127.0.0.1');
  });

  it('EXTENDS an envOverrides NO_PROXY instead of replacing it', () => {
    // `envOverrides` is spread after the projection, so the exemption has to run
    // after every spread or a caller-supplied rule would be pre-empted.
    const env = buildPiSubprocessEnv(parts({
      processEnv: { ALL_PROXY: 'http://proxy.corp.invalid:3128' },
      envOverrides: { NO_PROXY: 'internal.corp.invalid', no_proxy: 'internal.corp.invalid' },
    }));

    const entries = (env.NO_PROXY ?? '').split(',');
    expect(entries).toContain('internal.corp.invalid');
    for (const host of LOOPBACK) expect(entries).toContain(host);
    // The user's own rule stays first — its precedence is not reshuffled.
    expect(entries[0]).toBe('internal.corp.invalid');
  });

  it('leaves NO_PROXY alone when no proxy is set at all', () => {
    const env = buildPiSubprocessEnv(parts());

    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
  });

  it('is not fooled by a proxy variable that is present but empty', () => {
    const env = buildPiSubprocessEnv(parts({ processEnv: { HTTPS_PROXY: '   ' } }));

    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
  });

  it('still carries the rest of the spawn contract', () => {
    // The exemption is a mutator over the same object the spawn site used to
    // build inline — nothing else about that env may drift.
    const env = buildPiSubprocessEnv({
      processEnv: { PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy.corp.invalid:3128' },
      proxyEnv: { NODE_EXTRA_CA_CERTS: '/ca.pem' },
      envOverrides: { NESSY_WORKSPACE_ID: 'ws-1' },
      awsEnv: { AWS_REGION: 'eu-west-1' },
      sessionDir: '/sessions/p2259',
      sessionId: 'p2259-session',
      debug: true,
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/ca.pem');
    expect(env.NESSY_WORKSPACE_ID).toBe('ws-1');
    expect(env.AWS_REGION).toBe('eu-west-1');
    expect(env.NESSY_SESSION_DIR).toBe('/sessions/p2259');
    expect(env.NESSY_SESSION_ID).toBe('p2259-session');
    expect(env.NESSY_DEBUG).toBe('1');
  });

  it('omits NESSY_SESSION_DIR when the session has no directory', () => {
    const env = buildPiSubprocessEnv(parts());

    expect('NESSY_SESSION_DIR' in env).toBe(false);
    expect(env.NESSY_DEBUG).toBe('0');
  });
});

/**
 * P6.255 (children arm) — `NODE_USE_ENV_PROXY` on the Pi subprocess env.
 *
 * Node 24 stopped honouring `HTTP_PROXY`/`HTTPS_PROXY` in `fetch`/undici unless
 * this flag is set, and the name scored 0 files across `packages` + `apps` when
 * the row measured it. The codex arm landed in `c7d5e13dc`
 * (`codex-agent-server/src/runtime-manager.ts`); this is the Pi one, and the
 * ANSWER IS NOT THE SAME SHAPE.
 *
 * The Pi child ITSELF is **Bun**, not Node — `resolveBundledRuntimeFile`
 * resolves `<resources>/vendor/bun/bun` and the resolver's field is called
 * `nodeRuntimePath` for historical reasons only — and Bun honours the proxy
 * variables natively, reading them at launch (the measurement this file's
 * header already carries). So the flag does nothing for the Pi child; it is for
 * the Node processes that INHERIT this env from it — every `Bash` tool command
 * the model runs, and any Node program among them.
 *
 * WHAT EACH ARM KILLS:
 *  - the "no proxy" arm is the POSITIVE CONTROL: without it, "set when a proxy
 *    exists" is equally satisfied by setting it unconditionally, which is a
 *    change nobody asked for.
 *  - the operator-value arm dies if a present value is ever overwritten — an
 *    operator who wrote `0` decided this already.
 *  - the ordering arm dies if the flag is applied before the loopback
 *    exemption, which would let a newly proxy-honouring Node child route the
 *    local-model endpoint through the corporate proxy.
 */
describe('P6.255 NODE_USE_ENV_PROXY on the Pi subprocess env', () => {
  it('sets it when the host shell carries a proxy', () => {
    const env = buildPiSubprocessEnv(parts({
      processEnv: { HTTPS_PROXY: 'http://proxy.corp.invalid:3128' },
    }));

    expect(env.NODE_USE_ENV_PROXY).toBe('1');
  });

  it('is armed by every proxy spelling the merged env can carry', () => {
    for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      const env = buildPiSubprocessEnv(parts({
        processEnv: { [name]: 'http://proxy.corp.invalid:3128' },
      }));
      expect(env.NODE_USE_ENV_PROXY, name).toBe('1');
    }
  });

  it('fires on the Settings projection and on envOverrides too', () => {
    expect(buildPiSubprocessEnv(parts({
      proxyEnv: { HTTP_PROXY: 'http://proxy.corp.invalid:3128' },
    })).NODE_USE_ENV_PROXY).toBe('1');
    expect(buildPiSubprocessEnv(parts({
      envOverrides: { HTTPS_PROXY: 'http://proxy.corp.invalid:3128' },
    })).NODE_USE_ENV_PROXY).toBe('1');
  });

  it('leaves a machine with NO proxy byte-identical — the POSITIVE CONTROL', () => {
    const env = buildPiSubprocessEnv(parts());

    expect('NODE_USE_ENV_PROXY' in env).toBe(false);
  });

  it('is not fooled by a proxy variable that is present but empty', () => {
    const env = buildPiSubprocessEnv(parts({ processEnv: { HTTPS_PROXY: '   ' } }));

    expect('NODE_USE_ENV_PROXY' in env).toBe(false);
  });

  it('never overwrites an explicit operator value, including the OFF one', () => {
    for (const value of ['0', '1', 'anything']) {
      const env = buildPiSubprocessEnv(parts({
        processEnv: { HTTPS_PROXY: 'http://proxy.corp.invalid:3128', NODE_USE_ENV_PROXY: value },
      }));
      expect(env.NODE_USE_ENV_PROXY, value).toBe(value);
    }
  });

  it('runs AFTER the loopback exemption, so the local-model default stays direct', () => {
    // The order is load-bearing, not incidental: a Node grandchild that starts
    // honouring the proxy must still reach `http://localhost:11434` directly.
    const env = buildPiSubprocessEnv(parts({
      processEnv: { HTTPS_PROXY: 'http://proxy.corp.invalid:3128' },
    }));

    expect(env.NODE_USE_ENV_PROXY).toBe('1');
    for (const host of LOOPBACK) expect((env.no_proxy ?? '').split(',')).toContain(host);
  });
});

/**
 * P6.691 — the connection's credential header reaching the child, and the
 * inherited value that must not decide it.
 *
 * `buildPiSubprocessEnv` opens with `...processEnv`, so a name the HOST was
 * launched with lands in the child by default. For every other variable that is
 * the wanted behaviour; for this one it is a token quietly moving onto a header
 * the connection did not ask for, so the absent case DELETES rather than
 * omitting.
 */
describe('the credential header the interceptor reads (P6.691)', () => {
  const NAME = 'NESSY_UPSTREAM_CREDENTIAL_HEADER';

  it('stamps the connection choice for the child', () => {
    const env = buildPiSubprocessEnv({ ...parts(), credentialHeader: 'x-api-key' });

    expect(env[NAME]).toBe('x-api-key');
  });

  it('leaves the name unset when the connection made no choice', () => {
    expect(buildPiSubprocessEnv(parts())[NAME]).toBeUndefined();
  });

  /** The one that is not obvious, and the reason the branch has an `else`. */
  it('DELETES an inherited value rather than letting it through', () => {
    const env = buildPiSubprocessEnv(parts({ processEnv: { [NAME]: 'x-api-key' } }));

    expect(env[NAME]).toBeUndefined();
  });

  it('lets an explicit choice override an inherited one', () => {
    const env = buildPiSubprocessEnv({
      ...parts({ processEnv: { [NAME]: 'authorization' } }),
      credentialHeader: 'x-api-key',
    });

    expect(env[NAME]).toBe('x-api-key');
  });
});
