/**
 * DA2.2 half A - the external-model MCP whitelist and its predicate.
 *
 * Two things are under assertion and they fail for different reasons.
 *
 * **The SEED.** The list is not a preference, it is the reference's eight names
 * minus the one this repo declines to ship, and the arm below re-derives that
 * relation from `BUILTIN_DP_MCP_SERVERS` and `BUILTIN_DP_MCP_EXCLUSIONS` instead
 * of quoting "seven of eight". A name added here that this host does not ship,
 * or a builtin quietly renamed, goes red.
 *
 * **The PREDICATE.** Every verdict it is handed comes from the real
 * `classifyModelTarget`, never from a hand-written literal: an arm built on a
 * literal `{ restricted: true }` would keep passing on the day the classifier
 * stopped producing that verdict for the endpoint the arm names, which is the
 * only interesting way this can break.
 *
 * Nothing here touches a pool, a file or the environment.
 */
import { describe, expect, it } from 'bun:test';
import {
  EXTERNAL_MODEL_MCP_WHITELIST,
  isMcpServerAllowedForModelTarget,
  modelTargetWithholdsMcpServers,
  partitionMcpServersForModelTarget,
} from './external-model-mcp-whitelist.ts';
import { classifyModelTarget, NESSY_GATEWAY_CHAT_BASE_URL } from './upstream-target.ts';
import {
  BUILTIN_DP_MCP_EXCLUSIONS,
  BUILTIN_DP_MCP_SERVERS,
} from '../../../../mcp/builtin-dp-servers.ts';

/**
 * The donor's set, copied verbatim from
 * `packages/core/src/core/openaiContentGenerator/constants.ts` symbol
 * `EXTERNAL_MODEL_MCP_WHITELIST` at nessy-cli `9d94ec5d4` (read 2026-09-17).
 * Kept here so the 7-of-8 relation is checkable inside this tree.
 */
const REFERENCE_WHITELIST = [
  'dpJira', 'dpGitlab', 'dpWiki', 't-tracker', 'dpFinedog', 'dpSage', 'dpAllure', 'context7',
] as const;

/** An external vendor target, from the real classifier. */
const EXTERNAL = classifyModelTarget({ baseUrl: 'https://api.vendor.example/v1', model: 'anthropic/claude-x' });
/** A namespace this host cannot place - the fail-closed arm. */
const UNPLACEABLE = classifyModelTarget({ baseUrl: 'https://api.vendor.example/v1', model: 'who-knows/model-1' });
/** The verified gateway. */
const GATEWAY = classifyModelTarget({ baseUrl: NESSY_GATEWAY_CHAT_BASE_URL, model: 'anthropic/claude-x' });
/** A loopback adapter - the weights are on this machine. */
const LOOPBACK = classifyModelTarget({ baseUrl: 'http://127.0.0.1:8080/v1', model: 'anthropic/claude-x' });

const NOT_WHITELISTED = 'dpFs';

describe('the seed', () => {
  it('is the reference set minus the one name this host declines to ship', () => {
    const missing = REFERENCE_WHITELIST.filter(name => !EXTERNAL_MODEL_MCP_WHITELIST.has(name));
    expect(missing).toEqual(['context7']);
    // ...and it is missing because a DIFFERENT constant already refused it, not
    // because someone shortened a list.
    expect(BUILTIN_DP_MCP_EXCLUSIONS.map(entry => entry.name)).toContain('context7');
    // Nothing was invented: the whitelist adds no name the reference lacks.
    for (const name of EXTERNAL_MODEL_MCP_WHITELIST) {
      expect(REFERENCE_WHITELIST).toContain(name as (typeof REFERENCE_WHITELIST)[number]);
    }
  });

  it('names only servers this host actually ships', () => {
    const shipped = new Set(BUILTIN_DP_MCP_SERVERS.map(entry => entry.name));
    for (const name of EXTERNAL_MODEL_MCP_WHITELIST) expect(shipped.has(name)).toBe(true);
    // The control that proves the set above can answer `false`: the server the
    // withholding arms below use as their non-whitelisted example IS shipped,
    // so `shipped.has` is not vacuously true for every string.
    expect(shipped.has(NOT_WHITELISTED)).toBe(true);
    expect(EXTERNAL_MODEL_MCP_WHITELIST.has(NOT_WHITELISTED)).toBe(false);
  });
});

describe('modelTargetWithholdsMcpServers', () => {
  it('is true for an external vendor and for a namespace that cannot be placed', () => {
    expect(EXTERNAL.class).toBe('external-vendor');
    expect(UNPLACEABLE.class).toBe('unclassified');
    expect(modelTargetWithholdsMcpServers(EXTERNAL)).toBe(true);
    expect(modelTargetWithholdsMcpServers(UNPLACEABLE)).toBe(true);
  });

  it('is false for the gateway, for loopback, and when nothing classified', () => {
    expect(GATEWAY.class).toBe('nessy-gateway');
    expect(LOOPBACK.class).toBe('loopback');
    expect(modelTargetWithholdsMcpServers(GATEWAY)).toBe(false);
    expect(modelTargetWithholdsMcpServers(LOOPBACK)).toBe(false);
    expect(modelTargetWithholdsMcpServers(undefined)).toBe(false);
  });
});

describe('isMcpServerAllowedForModelTarget', () => {
  it('withholds a non-whitelisted server from an external vendor and keeps a whitelisted one', () => {
    expect(isMcpServerAllowedForModelTarget(NOT_WHITELISTED, EXTERNAL)).toBe(false);
    expect(isMcpServerAllowedForModelTarget('dpJira', EXTERNAL)).toBe(true);
  });

  it('withholds nothing from the gateway, from loopback, or without a verdict', () => {
    expect(isMcpServerAllowedForModelTarget(NOT_WHITELISTED, GATEWAY)).toBe(true);
    expect(isMcpServerAllowedForModelTarget(NOT_WHITELISTED, LOOPBACK)).toBe(true);
    expect(isMcpServerAllowedForModelTarget(NOT_WHITELISTED, undefined)).toBe(true);
  });

  /**
   * The posture the module's own note argues for, made falsifiable: an
   * UNPREFIXED model id is the common case at a vendor, not the odd one, and the
   * rule must read the `restricted` FLAG rather than the class. A rule reading
   * the class would hand every MCP server to whichever of these it did not list.
   * If a future lane narrows the rule, this is the case that says what was given
   * up.
   *
   * **D1.191 re-wrote the assertion and not the invariant.** This case used to
   * pin `['unclassified', 'unclassified']` with the comment *"neither is
   * `external-vendor` — that is the whole point of the case"*, and the two pairs
   * below are exactly the two SUBSCRIPTION cards' shapes: the vendor-host
   * vocabulary now names them `external-vendor` so a user is not told the
   * vendor's own front door *could not be classified*. `restricted` did not
   * move, which is why nothing about the withholding changed — so the case is
   * now stronger than it was, because it drives TWO different classes through
   * one rule and the third pair below is the unlisted host that still lands in
   * `unclassified` and is withheld from just the same.
   */
  it('withholds from an unprefixed model id whatever CLASS the host gives it', () => {
    const openai = classifyModelTarget({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' })
    const anthropic = classifyModelTarget({
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5-20250929',
    })
    const unlistedHost = classifyModelTarget({ baseUrl: 'https://proxy.example.test/v1', model: 'gpt-4o' })
    // Two classes, one flag — the flag is what the rule may read.
    expect([openai.class, anthropic.class, unlistedHost.class])
      .toEqual(['external-vendor', 'external-vendor', 'unclassified'])
    expect([openai.restricted, anthropic.restricted, unlistedHost.restricted]).toEqual([true, true, true])
    expect(isMcpServerAllowedForModelTarget(NOT_WHITELISTED, openai)).toBe(false)
    expect(isMcpServerAllowedForModelTarget(NOT_WHITELISTED, anthropic)).toBe(false)
    expect(isMcpServerAllowedForModelTarget(NOT_WHITELISTED, unlistedHost)).toBe(false)
    // ...and the seven still work there, so this is a withholding and not a ban.
    expect(isMcpServerAllowedForModelTarget('dpWiki', anthropic)).toBe(true)
  })

  it('is the BYO half of the owner decision: a BYO endpoint at a vendor is restricted too', () => {
    // DA2.14 amended DP-5's exemption away. The endpoint below is a user's own
    // key at a vendor; the verdict and the withholding are identical to the
    // corporate-channel case above, which is what "no BYO exemption" means.
    const byoAtVendor = classifyModelTarget({ baseUrl: 'https://api.openai.com/v1', model: 'openai/gpt-x' });
    expect(byoAtVendor.restricted).toBe(true);
    expect(isMcpServerAllowedForModelTarget(NOT_WHITELISTED, byoAtVendor)).toBe(false);
    expect(isMcpServerAllowedForModelTarget('dpGitlab', byoAtVendor)).toBe(true);
  });
});

describe('partitionMcpServersForModelTarget', () => {
  it('splits and sorts both halves for an external vendor', () => {
    const { allowed, withheld } = partitionMcpServersForModelTarget(
      ['dpFs', 'dpJira', 'my-server', 'dpGitlab'],
      EXTERNAL,
    );
    expect(allowed).toEqual(['dpGitlab', 'dpJira']);
    expect(withheld).toEqual(['dpFs', 'my-server']);
  });

  it('withholds nothing when the target is not restricted', () => {
    const { allowed, withheld } = partitionMcpServersForModelTarget(['dpFs', 'my-server'], GATEWAY);
    expect(allowed).toEqual(['dpFs', 'my-server']);
    expect(withheld).toEqual([]);
  });
});
