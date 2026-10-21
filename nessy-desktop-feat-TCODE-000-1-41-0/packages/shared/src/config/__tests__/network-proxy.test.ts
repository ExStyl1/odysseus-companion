/**
 * Tests for network proxy bypass rules (NO_PROXY parsing and matching).
 */
import { describe, it, expect } from 'bun:test';
import { rootCertificates } from 'node:tls';
import { buildUndiciDispatcherConfig, composeCaTrust, LOOPBACK_NO_PROXY_HOSTS, parseNoProxyRules, shouldBypassProxy } from '../network-proxy-utils.ts';

describe('buildUndiciDispatcherConfig', () => {
  it('a composed corporate-CA trust set still unions the Mozilla roots', () => {
    // Regression: the extra CA must be UNIONED with the default Mozilla roots,
    // not replace them. A bare `ca: ['corporate-ca']` would drop every public
    // root and break public-root hosts (remote agents, github, Nestor Cloud).
    // The union now happens in composeCaTrust; this pins the composed path
    // end-to-end on a runtime without an OS-store reader (degraded mode).
    const trust = composeCaTrust({ sources: ['bundled', 'system'], extraCa: 'corporate-ca', getCACertificates: undefined });
    const config = buildUndiciDispatcherConfig(trust.ca);
    const expected = [...rootCertificates, 'corporate-ca'];

    expect(config.directAgentOptions?.connect.ca).toEqual(expected);
    expect(config.proxyAgentTlsOptions?.requestTls.ca).toEqual(expected);
    expect(config.proxyAgentTlsOptions?.proxyTls.ca).toEqual(expected);

    // Guard the shape independently of how many roots the runtime ships.
    const ca = config.directAgentOptions?.connect.ca;
    expect(Array.isArray(ca)).toBe(true);
    expect(ca).toContain('corporate-ca');
    // The corporate CA is appended last; system roots precede it.
    expect(ca?.[ca.length - 1]).toBe('corporate-ca');
  });

  it('omits TLS option fields when no CA set is composed', () => {
    const config = buildUndiciDispatcherConfig();

    expect(config).toEqual({});
    expect(config).not.toHaveProperty('directAgentOptions');
    expect(config).not.toHaveProperty('proxyAgentTlsOptions');
  });
});

describe('parseNoProxyRules', () => {
  it('returns empty array for undefined/empty input', () => {
    expect(parseNoProxyRules(undefined)).toEqual([]);
    expect(parseNoProxyRules('')).toEqual([]);
  });

  it('parses simple hostnames', () => {
    const rules = parseNoProxyRules('localhost, example.com');
    expect(rules).toEqual([
      { host: 'localhost', wildcard: false },
      { host: 'example.com', wildcard: false },
    ]);
  });

  it('parses wildcard', () => {
    const rules = parseNoProxyRules('*');
    expect(rules).toEqual([{ host: '*', wildcard: true }]);
  });

  it('strips leading dot', () => {
    const rules = parseNoProxyRules('.example.com');
    expect(rules).toEqual([{ host: 'example.com', wildcard: false }]);
  });

  it('parses host:port', () => {
    const rules = parseNoProxyRules('example.com:8080');
    expect(rules).toEqual([{ host: 'example.com', port: 8080, wildcard: false }]);
  });

  it('treats the page\'s two documented spellings identically (network-config.md:30-33)', () => {
    // The doc's OWN two example strings, verbatim: space-separated and
    // comma-separated forms of the same NO_PROXY value.
    const spaceForm = 'localhost 192.168.1.1 example.com .example.com';
    const commaForm = 'localhost,192.168.1.1,example.com,.example.com';

    const spaceRules = parseNoProxyRules(spaceForm);
    const commaRules = parseNoProxyRules(commaForm);
    expect(spaceRules).toEqual(commaRules);
    expect(spaceRules).toHaveLength(4);

    // Identical bypass verdicts, not just identical rule arrays.
    for (const url of [
      'http://localhost:3000/x',
      'https://example.com',
      'https://api.example.com/v1',
      'http://192.168.1.1/',
    ]) {
      expect(shouldBypassProxy(url, spaceRules)).toBe(true);
      expect(shouldBypassProxy(url, commaRules)).toBe(true);
    }
  });

  it('handles mixed and repeated separators as one delimiter run', () => {
    const rules = parseNoProxyRules('localhost,  example.com\t.internal');
    expect(rules).toEqual([
      { host: 'localhost', wildcard: false },
      { host: 'example.com', wildcard: false },
      { host: 'internal', wildcard: false },
    ]);
  });

  // The whole colon disambiguation in one table, in BOTH directions: the bug
  // was a separator being misread, so the risk of the fix is a form that
  // worked before changing meaning. Every row that predates the fix is here
  // alongside the ones it adds.
  it.each([
    // --- the reported defect: a bare, unbracketed IPv6 literal -------------
    ['::1', { host: '::1', wildcard: false }],
    ['2001:db8::1', { host: '2001:db8::1', wildcard: false }],
    ['::', { host: '::', wildcard: false }],
    ['::ffff:127.0.0.1', { host: '::ffff:127.0.0.1', wildcard: false }],
    // --- bracketed IPv6 parsed correctly before, and still does -----------
    ['[::1]', { host: '::1', wildcard: false }],
    ['[::1]:8080', { host: '::1', port: 8080, wildcard: false }],
    ['[2001:db8::1]:8080', { host: '2001:db8::1', port: 8080, wildcard: false }],
    // --- the port separator, which must keep working: one colon only ------
    ['example.com:8080', { host: 'example.com', port: 8080, wildcard: false }],
    ['192.168.1.1:8080', { host: '192.168.1.1', port: 8080, wildcard: false }],
    // --- no colon at all --------------------------------------------------
    ['192.168.1.1', { host: '192.168.1.1', wildcard: false }],
    ['example.com', { host: 'example.com', wildcard: false }],
    ['.example.com', { host: 'example.com', wildcard: false }],
    ['*', { host: '*', wildcard: true }],
    // --- malformed leftovers: unchanged, and deliberately not "improved" --
    [':8080', { host: ':8080', wildcard: false }],
    ['host:notaport', { host: 'host:notaport', wildcard: false }],
  ])('resolves the host/port colon for %s', (entry, expected) => {
    expect(parseNoProxyRules(entry)).toEqual([expected]);
  });

  // The comment on LOOPBACK_RULES promises the direct construction and the
  // parser agree now that the parser accepts the bare spelling. Pin it, so a
  // future parser change cannot silently split the host's unconditional
  // loopback exemption from the list every subprocess env is given.
  //
  // The bracket strip on both sides is the P2.471 half: the constant now
  // carries `[::1]` as well, for the subprocess parsers that accept only that
  // spelling, and BOTH the parser and LOOPBACK_RULES fold it onto `::1` because
  // this process matches against a bracket-stripped URL host. Written out
  // rather than reusing the source's helper, so a change to that helper shows
  // up here as a failure instead of being silently agreed with.
  it('reproduces the loopback list the exemption is built from', () => {
    expect(parseNoProxyRules(LOOPBACK_NO_PROXY_HOSTS.join(','))).toEqual(
      LOOPBACK_NO_PROXY_HOSTS.map(host => ({
        host: host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host,
        wildcard: false,
      })),
    );
  });

  it('carries both IPv6 spellings, and folds them onto one rule', () => {
    // The row's whole point: neither spelling is correct everywhere, so the
    // constant holds both. Asserted on the constant itself because every
    // subprocess env is built from it — see its docblock for the six
    // implementations measured.
    expect([...LOOPBACK_NO_PROXY_HOSTS]).toEqual(['localhost', '127.0.0.1', '::1', '[::1]']);
    expect(parseNoProxyRules('::1')).toEqual(parseNoProxyRules('[::1]'));
  });
});

describe('shouldBypassProxy', () => {
  it('returns false when no rules', () => {
    expect(shouldBypassProxy('https://example.com', [])).toBe(false);
  });

  it('matches exact host', () => {
    const rules = parseNoProxyRules('localhost');
    expect(shouldBypassProxy('http://localhost:3000/path', rules)).toBe(true);
    expect(shouldBypassProxy('http://example.com', rules)).toBe(false);
  });

  it('matches subdomain (suffix)', () => {
    const rules = parseNoProxyRules('example.com');
    expect(shouldBypassProxy('https://api.example.com/v1', rules)).toBe(true);
    expect(shouldBypassProxy('https://example.com', rules)).toBe(true);
    expect(shouldBypassProxy('https://notexample.com', rules)).toBe(false);
  });

  it('respects port-scoped rules', () => {
    const rules = parseNoProxyRules('example.com:8080');
    expect(shouldBypassProxy('http://example.com:8080/path', rules)).toBe(true);
    expect(shouldBypassProxy('http://example.com:9090/path', rules)).toBe(false);
  });

  it('matches implicit default ports', () => {
    const rules443 = parseNoProxyRules('example.com:443');
    // https default port is 443 — should match even without explicit port
    expect(shouldBypassProxy('https://example.com/path', rules443)).toBe(true);
    // http default port is 80 — should NOT match a :443 rule
    expect(shouldBypassProxy('http://example.com/path', rules443)).toBe(false);

    const rules80 = parseNoProxyRules('example.com:80');
    expect(shouldBypassProxy('http://example.com/path', rules80)).toBe(true);
    expect(shouldBypassProxy('https://example.com/path', rules80)).toBe(false);

    // Explicit port that differs from rule should not match
    const rules8080 = parseNoProxyRules('example.com:8080');
    expect(shouldBypassProxy('https://example.com/path', rules8080)).toBe(false);
  });

  it('wildcard bypasses everything', () => {
    const rules = parseNoProxyRules('*');
    expect(shouldBypassProxy('https://anything.example.com', rules)).toBe(true);
  });

  // This case used to be written against `[::1]`, where it proved nothing:
  // shouldBypassProxy exempts loopback UNCONDITIONALLY before it looks at the
  // rules, so it passed with an empty rule array too. A documentation-range
  // address (RFC 3849) is outside that exemption, so the rule has to do the
  // work — and the empty-rules control below is what says so.
  it('bypasses on an IPv6 rule, bare or bracketed, and only because of the rule', () => {
    for (const entry of ['2001:db8::1', '[2001:db8::1]']) {
      const rules = parseNoProxyRules(entry);
      expect(shouldBypassProxy('http://[2001:db8::1]:3000/path', rules)).toBe(true);
      expect(shouldBypassProxy('http://[2001:db8::2]/path', rules)).toBe(false);
    }
    expect(shouldBypassProxy('http://[2001:db8::1]:3000/path', [])).toBe(false);
  });

  it('honours a port on an IPv6 rule, bare host or bracketed', () => {
    const rules = parseNoProxyRules('[2001:db8::1]:8080');
    expect(shouldBypassProxy('http://[2001:db8::1]:8080/path', rules)).toBe(true);
    expect(shouldBypassProxy('http://[2001:db8::1]:9090/path', rules)).toBe(false);
  });

  it('exempts the loopback IPv6 literal with no rules at all', () => {
    // Not the rule path: the unconditional exemption P2.263 added. Kept
    // separate so the case above stays a real detector.
    expect(shouldBypassProxy('http://[::1]:3000/path', [])).toBe(true);
  });

  it('matches exact IP literal', () => {
    const rules = parseNoProxyRules('192.168.1.1');
    expect(shouldBypassProxy('http://192.168.1.1/', rules)).toBe(true);
    expect(shouldBypassProxy('http://10.0.0.1/', rules)).toBe(false);
  });
});
