/**
 * P2.471 — `LOOPBACK_NO_PROXY_HOSTS` carries BOTH IPv6 loopback spellings,
 * because the parsers that read it disagree in opposite directions.
 *
 * This is the SUBPROCESS half of P2.382. That row fixed `parseNoProxyRules`,
 * which governs this process only; the three subprocess environments built from
 * this constant are each parsed by the runtime that receives them, and each
 * runtime answers differently:
 *
 * | subprocess | the parser that actually decides          | needs   | evidence |
 * | ---------- | ---------------------------------------- | ------- | -------- |
 * | Pi         | Bun 1.3.14 native `fetch`                | `[::1]` | measured live |
 * | claude     | `proxy-from-env` 2.1.0, verbatim in the binary | `[::1]` | source + P2.382 |
 * | codex      | `hyper-util` 0.1.20 (`reqwest` 0.12.28)  | `::1`   | measured, real crate |
 *
 * ## Why this file replicates two parsers instead of running them
 *
 * Neither real parser can be called from a Bun test: `proxy-from-env` is a
 * TRANSITIVE dependency (of `axios`) that nothing here declares, and importing
 * it would make this suite depend on another package's lockfile entry; the codex
 * one is Rust inside a 178 MB binary. So each family is replicated from its own
 * source, quoted verbatim below, and the replicas are held honest two ways:
 * every family has a NEGATIVE CONTROL arm (empty list, and a remote host) that
 * must come out "proxied", and the IP family's decisive primitive is delegated
 * to `node:net`'s real address parser rather than hand-rolled, with its
 * accept/reject shape asserted.
 *
 * ## The live measurements these replicas stand in for (2026-08-31)
 *
 * Bun 1.3.14 native `fetch`, a real sink proxy on 127.0.0.1 and a real target
 * on `[::1]`, one throwaway child per arm with an EXPLICIT env (a mutated
 * `process.env` is invisible to a spread on this Bun — P2.261):
 *
 * | no_proxy                        | url                   | who got the request |
 * | ------------------------------- | --------------------- | ------------------- |
 * | `::1`                           | `http://[::1]:<t>/`   | SINK                |
 * | `[::1]`                         | `http://[::1]:<t>/`   | target              |
 * | `localhost,127.0.0.1,::1`   OLD | `http://[::1]:<t>/`   | SINK                |
 * | `localhost,127.0.0.1,::1,[::1]` | `http://[::1]:<t>/`   | target              |
 * | (unset), proxy set   control    | `http://[::1]:<t>/`   | SINK                |
 * | (unset), no proxy    control    | `http://[::1]:<t>/`   | target              |
 * | full new value                  | `http://127.0.0.1:<t>/` | target            |
 * | full new value                  | `http://models.example.invalid/` | SINK     |
 *
 * `hyper-util` 0.1.20 `Matcher::intercept`, built and run against the exact
 * crate versions `strings` reports inside
 * `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`
 * (`reqwest-0.12.28`, `hyper-util-0.1.20`, `ipnet-2.11.0`,
 * `client/proxy/matcher.rs`): `::1` → BYPASSED, `[::1]` → proxied, empty →
 * proxied, full new value → BYPASSED for `[::1]`, `127.0.0.1` and `localhost`
 * and proxied for `models.example.com`. Exactly the inverse of Bun.
 *
 * A THIRD implementation, measured because this env is inherited by everything
 * the model launches through `Bash`: `curl` 8.7.1 and Go 1.24.3's
 * `ProxyFromEnvironment` are both in the bare-only family. Go additionally
 * exempts loopback with no entry at all, which makes every LOOPBACK arm on Go a
 * dead arm — its grammar had to be measured on an RFC 3849 documentation
 * address instead, where bare bypasses and bracketed does not.
 */
import { describe, expect, it } from 'bun:test';
import { isIP } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LOOPBACK_NO_PROXY_HOSTS } from '../network-proxy-utils.ts';
import { applyLoopbackProxyExemption, extendNoProxyWithLoopback } from '../proxy-env.ts';

/** The value a claude/Pi subprocess env actually receives. */
function subprocessNoProxy(operatorValue?: string): string {
  const env: Record<string, string | undefined> = {
    HTTPS_PROXY: 'http://proxy.corp.invalid:3128',
    ...(operatorValue === undefined ? {} : { NO_PROXY: operatorValue }),
  };
  applyLoopbackProxyExemption(env);
  return env.NO_PROXY!;
}

// ---------------------------------------------------------------------------
// Family 1 — the JS parsers. `proxy-from-env` 2.1.0 `getProxyForUrl` +
// `shouldProxy`, replicated from `node_modules/proxy-from-env/index.js`. The
// two lines that decide the spelling, verbatim:
//
//   var hostname = parsedUrl.host;             // brackets and port kept
//   // "Stripping ports in this way instead of using parsedUrl.hostname to make
//   //  sure that the brackets around IPv6 addresses are kept."
//   hostname = hostname.replace(/:\d*$/, '');
//   ...
//   var parsedProxy = proxy.match(/^(.+):(\d+)$/);
//   var parsedProxyHostname = parsedProxy ? parsedProxy[1] : proxy;
//   var parsedProxyPort = parsedProxy ? parseInt(parsedProxy[2]) : 0;
//   if (parsedProxyPort && parsedProxyPort !== port) return true;
//   if (!/^[.*]/.test(parsedProxyHostname)) return hostname !== parsedProxyHostname;
//
// So a bare `::1` entry is not merely inert here: `/^(.+):(\d+)$/` reads it as
// host `::` on port 1, and a port mismatch makes the entry skip itself.
// ---------------------------------------------------------------------------
const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

function jsFamilyBypasses(noProxy: string, url: string): boolean {
  const parsed = new URL(url);
  const proto = parsed.protocol.split(':', 1)[0]!;
  const hostname = parsed.host.replace(/:\d*$/, '');
  const port = parseInt(parsed.port, 10) || DEFAULT_PORTS[proto] || 0;

  const list = noProxy.toLowerCase();
  if (!list) return false;
  if (list === '*') return true;

  // `.every(entry => keep proxying)` — a bypass is any entry answering false.
  return !list.split(/[,\s]/).every((entry) => {
    if (!entry) return true;
    const match = entry.match(/^(.+):(\d+)$/);
    let entryHost = match ? match[1]! : entry;
    const entryPort = match ? parseInt(match[2]!, 10) : 0;
    if (entryPort && entryPort !== port) return true;
    if (!/^[.*]/.test(entryHost)) return hostname !== entryHost;
    if (entryHost.charAt(0) === '*') entryHost = entryHost.slice(1);
    return !hostname.endsWith(entryHost);
  });
}

// ---------------------------------------------------------------------------
// Family 2 — the IP-parsing parsers. `hyper-util` 0.1.20
// `src/client/proxy/matcher.rs`, which is what `reqwest` 0.12.28 delegates
// `no_proxy` to, and therefore what the shipped codex binary uses. Verbatim:
//
//   pub fn from_string(no_proxy_list: &str) -> Self {
//       let parts = no_proxy_list.split(',').map(str::trim);
//       for part in parts {
//           match part.parse::<IpNet>() {
//               // If we can parse an IP net or address, then use it, otherwise, assume it is a domain
//               Ok(ip) => ips.push(Ip::Network(ip)),
//               Err(_) => match part.parse::<IpAddr>() {
//                   Ok(addr) => ips.push(Ip::Address(addr)),
//                   Err(_) => { if !part.trim().is_empty() { domains.push(part.to_owned()) } }
//   pub fn contains(&self, host: &str) -> bool {
//       // According to RFC3986, raw IPv6 hosts will be wrapped in []. So we need to strip those off
//       let host = if host.starts_with('[') { host.trim_matches(&['[', ']'][..]) } else { host };
//       match host.parse::<IpAddr>() {
//           Ok(ip) => self.ips.contains(ip),      // the DOMAIN list is never consulted
//           Err(_) => self.domains.contains(host),
//
// `Matcher::intercept` consults nothing else — no unconditional loopback
// exemption — so for `http://[::1]:<port>` the answer is decided entirely by
// whether `::1` reached the IP list. `[::1]` cannot: it parses as neither net
// nor address, lands in `domains`, and an IP host never reads that list.
//
// CIDR entries are out of this replica's scope; no arm below uses one, and the
// loopback constant contains none.
// ---------------------------------------------------------------------------
function canonicalIp(value: string): string | undefined {
  if (isIP(value) === 0) return undefined;
  // A real address canonicaliser, so the replica compares addresses the way
  // Rust's `IpAddr` equality does rather than comparing strings:
  // `0:0:0:0:0:0:0:1` and `::1` are the same host.
  // WHATWG `hostname` keeps the brackets on an IPv6 host, so they come back off.
  return isIP(value) === 6
    ? new URL(`http://[${value}]/`).hostname.replace(/^\[|\]$/g, '')
    : value;
}

function ipFamilyBypasses(noProxy: string, url: string): boolean {
  const ips: string[] = [];
  const domains: string[] = [];
  for (const raw of noProxy.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const ip = canonicalIp(part);
    if (ip !== undefined) ips.push(ip);
    else domains.push(part.toLowerCase());
  }

  let host = new URL(url).host.replace(/:\d*$/, '');
  if (host.startsWith('[')) host = host.replace(/^\[|\]$/g, '');
  const asIp = canonicalIp(host);
  if (asIp !== undefined) return ips.includes(asIp);
  return domains.some((d) => d === host.toLowerCase()
    || host.toLowerCase().endsWith(d.startsWith('.') ? d : `.${d}`));
}

const V6 = 'http://[::1]:9100/health';
const V4 = 'http://127.0.0.1:9100/health';
const REMOTE = 'https://models.example.com/v1/models';

describe('the replicas are instruments, so their own primitives are pinned', () => {
  it('delegates the IP-literal decision to a real address parser', () => {
    // The whole `::1` vs `[::1]` split lives in this one accept/reject shape. A
    // replica that got it wrong would agree with itself and prove nothing.
    expect(isIP('::1')).toBe(6);
    expect(isIP('[::1]')).toBe(0);
    expect(canonicalIp('0:0:0:0:0:0:0:1')).toBe('::1');
  });

  it('keeps the brackets on the URL host for the JS family and strips them for the IP family', () => {
    expect(new URL(V6).host.replace(/:\d*$/, '')).toBe('[::1]');
    expect(new URL(V6).hostname).toBe('[::1]');
  });
});

describe('the JS family — proxy-from-env 2.1.0, verbatim inside the claude binary, and Bun own fetch (Pi)', () => {
  it('bypasses the IPv6 loopback on the value the subprocess env actually gets', () => {
    // THE DISCRIMINATING ARM for the bracketed spelling. Killed by dropping
    // `[::1]` from LOOPBACK_NO_PROXY_HOSTS; unaffected by dropping `::1`.
    expect(jsFamilyBypasses(subprocessNoProxy(), V6)).toBe(true);
  });

  it('needs the bracketed entry ALONE, and the bare one alone is not enough', () => {
    expect(jsFamilyBypasses('[::1]', V6)).toBe(true);
    expect(jsFamilyBypasses('::1', V6)).toBe(false);
  });

  it('control: an empty list and a remote host are both still proxied', () => {
    // Without this the arm above could pass on a parser that bypasses
    // everything — which is what a naive `no_proxy=*` would look like.
    expect(jsFamilyBypasses('', V6)).toBe(false);
    expect(jsFamilyBypasses(subprocessNoProxy(), REMOTE)).toBe(false);
  });

  it('keeps the v4 and hostname loopback entries working', () => {
    expect(jsFamilyBypasses(subprocessNoProxy(), V4)).toBe(true);
    expect(jsFamilyBypasses(subprocessNoProxy(), 'http://localhost:11434/v1/models')).toBe(true);
  });
});

describe('the IP-parsing family — hyper-util 0.1.20 / reqwest 0.12.28, the codex binary', () => {
  it('bypasses the IPv6 loopback on the value the subprocess env actually gets', () => {
    // THE DISCRIMINATING ARM for the bare spelling. Killed by dropping `::1`
    // from LOOPBACK_NO_PROXY_HOSTS; unaffected by dropping `[::1]`.
    expect(ipFamilyBypasses(subprocessNoProxy(), V6)).toBe(true);
  });

  it('needs the bare entry ALONE, and the bracketed one alone is not enough', () => {
    expect(ipFamilyBypasses('::1', V6)).toBe(true);
    expect(ipFamilyBypasses('[::1]', V6)).toBe(false);
  });

  it('control: an empty list and a remote host are both still proxied', () => {
    expect(ipFamilyBypasses('', V6)).toBe(false);
    expect(ipFamilyBypasses(subprocessNoProxy(), REMOTE)).toBe(false);
  });

  it('keeps the v4 and hostname loopback entries working', () => {
    expect(ipFamilyBypasses(subprocessNoProxy(), V4)).toBe(true);
    expect(ipFamilyBypasses(subprocessNoProxy(), 'http://localhost:11434/v1/models')).toBe(true);
  });
});

describe('the two families really do disagree — the reason one spelling cannot work', () => {
  it('answers oppositely for each spelling taken alone', () => {
    expect([jsFamilyBypasses('::1', V6), ipFamilyBypasses('::1', V6)]).toEqual([false, true]);
    expect([jsFamilyBypasses('[::1]', V6), ipFamilyBypasses('[::1]', V6)]).toEqual([true, false]);
  });

  it('and agrees on the shipped value, which is the point of carrying both', () => {
    const value = subprocessNoProxy();
    expect([jsFamilyBypasses(value, V6), ipFamilyBypasses(value, V6)]).toEqual([true, true]);
  });

  it('is INVISIBLE on a 127.0.0.1 url — the dead arm that made P2.251/P2.259 wrong', () => {
    // Asserted rather than merely noted, so nobody re-derives the spelling
    // question from a v4 arm again: with the pre-fix value both families bypass
    // a v4 loopback URL, and the IPv6 entry contributes nothing either way.
    const preFix = 'localhost,127.0.0.1,::1';
    expect([jsFamilyBypasses(preFix, V4), ipFamilyBypasses(preFix, V4)]).toEqual([true, true]);
    expect([jsFamilyBypasses(preFix, V6), ipFamilyBypasses(preFix, V6)]).toEqual([false, true]);
  });
});

describe('the value every consumer is built from', () => {
  it('unions both spellings into the canonical comma form', () => {
    expect(extendNoProxyWithLoopback([undefined])).toBe('localhost,127.0.0.1,::1,[::1]');
  });

  it('adds the missing spelling when the operator already wrote one of them', () => {
    expect(subprocessNoProxy('::1')).toBe('::1,localhost,127.0.0.1,[::1]');
    expect(subprocessNoProxy('[::1]')).toBe('[::1],localhost,127.0.0.1,::1');
  });

  /**
   * The codex twin is a COPY (`applyLoopbackNoProxy` in
   * `packages/codex-agent-server/src/runtime-manager.ts`, which cannot import
   * this package without closing a cycle), so nothing else can notice the two
   * drifting apart. Read as source text on purpose: a runtime import would need
   * the cycle this guard exists because of.
   */
  it('is byte-identical in the codex twin, which cannot import it', () => {
    const twin = readFileSync(
      resolve(import.meta.dir, '../../../../codex-agent-server/src/runtime-manager.ts'),
      'utf8',
    );
    // Non-greedy to `] as const;` on purpose: `[^\]]*` would stop at the `]`
    // INSIDE the `'[::1]'` entry and silently compare a truncated list.
    const match = twin.match(/const LOOPBACK_NO_PROXY_HOSTS = \[([\s\S]*?)\] as const;/);
    // Never let a regex that stopped matching read as agreement.
    expect(match).not.toBeNull();
    const entries = match![1]!.split(',').map((e) => e.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(entries).toEqual([...LOOPBACK_NO_PROXY_HOSTS]);
  });
});
