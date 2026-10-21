/**
 * Tests for send_developer_feedback tool permission handling across permission modes.
 *
 * send_developer_feedback is a session-scoped MCP tool that, *when its feature
 * flag is enabled*, should be allowed in ALL permission modes — including
 * safe/Explore — so product issues can be reported without requiring mode
 * switches. The flag (FEATURE_FLAGS.developerFeedback) defaults off in
 * production runtimes; we force it on here so the test exercises the
 * intended end-state contract regardless of NODE_ENV.
 *
 * P2.189 measured which rows can bite, all four having been a bare
 * `expect(result.allowed).toBe(true)`. `shouldAllowToolInMode` answers
 * `allowed: true` for EVERY tool in `default` and `bypassPermissions`, so the
 * rows in those modes hold with the flag forced OFF and for a tool name that
 * exists nowhere — i.e. the `beforeAll` that flips the flag was doing no work
 * for three of the four rows.
 *
 * P3.311 then moved the Explore gate onto the DECLARATION (`safeMode`) over the
 * whole registry, so `explore` no longer discriminates on the flag either and
 * the same-fixture control P2.189 relied on is gone from the permission side.
 * It is not lost: the flag's real job is AVAILABILITY, and the row below
 * asserts it per OFFER SURFACE — which is both where the flag is enforced and a
 * stronger check than the verdict it replaces, because
 * `getSessionToolDefs` defaults `includeDeveloperFeedback` to TRUE and only a
 * builder that passes the flag withholds anything.
 */
import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import { getSessionToolDefs, getSessionToolRegistry } from '@nessy-agent/session-tools-core';
import { shouldAllowToolInMode } from '../../agent/mode-manager.ts';
import { getSessionToolProxyDefs } from '../backend/pi/session-tool-defs.ts';
import { FEATURE_FLAGS } from '../../feature-flags.ts';

const FLAG_ENV = 'NESSY_FEATURE_DEVELOPER_FEEDBACK';
/** The bare tool name, as the registry and the offer surfaces spell it. */
const NAME = 'send_developer_feedback';

describe('send_developer_feedback permission mode handling', () => {
  const toolName = 'mcp__session__send_developer_feedback';
  const input = { message: 'Feedback content' };

  let originalFlag: string | undefined;

  beforeAll(() => {
    originalFlag = process.env[FLAG_ENV];
    process.env[FLAG_ENV] = '1';
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env[FLAG_ENV];
    else process.env[FLAG_ENV] = originalFlag;
  });

  it('is allowed in plan mode, by its DECLARATION — P3.311', () => {
    // This row used to flip the flag and assert the Explore verdict flipped
    // with it. P3.311 moved the Explore gate onto the declaration
    // (`safeMode`) over the whole registry, so the verdict no longer reads the
    // flag — and the row that follows this one is where the flag's real
    // enforcement is now asserted, which is a STRONGER control than the one
    // removed rather than a lost one.
    //
    // The change is safe for this tool specifically because the flag withholds
    // it from every OFFER surface (measured in the next row), so with the flag
    // off it is not advertised on Pi, claude or codex and the gate's refusal
    // was unreachable belt-and-braces. It also stopped being a refusal anyone
    // would want: the message is "Session configuration changes are blocked",
    // which is false for a feedback tool.
    expect(shouldAllowToolInMode(toolName, input, 'plan').allowed).toBe(true);
    // The control on the NAME, unchanged: an ungranted sibling in the same
    // namespace is denied in this mode, so the row cannot pass by naming the
    // wrong tool or by the gate having become permissive.
    expect(shouldAllowToolInMode(`${toolName}_x`, input, 'plan').allowed).toBe(false);
  });

  it('the flag is enforced where it lives — it withholds the tool from every OFFER surface', () => {
    // P3.311. The flag's job is AVAILABILITY, and this is the row that proves
    // it does that job on all three runtimes rather than relying on a
    // permission verdict to finish it. `getSessionToolDefs`'s own default is
    // `includeDeveloperFeedback ?? true`, so a builder that forgets to pass the
    // flag advertises the tool regardless — which is exactly why this is
    // asserted per surface and not once.
    // Pi's projection emits PREFIXED names (`mcp__session__…`) while the
    // registry uses bare ones, so the match is on the suffix — measured, after
    // an exact-match first draft reported the tool missing with the flag ON.
    const offered = (defs: { name: string }[]) =>
      defs.some(def => def.name === NAME || def.name.endsWith(`__${NAME}`));

    process.env[FLAG_ENV] = '1';
    expect(offered(getSessionToolDefs({ includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback })))
      .toBe(true);
    expect(offered(getSessionToolProxyDefs() as unknown as { name: string }[])).toBe(true);

    process.env[FLAG_ENV] = '0';
    try {
      expect(FEATURE_FLAGS.developerFeedback, 'the flag must be read per call for this row to work').toBe(false);
      // Pi's projection, which passes the flag itself.
      expect(offered(getSessionToolProxyDefs() as unknown as { name: string }[])).toBe(false);
      // The shape claude's in-process server and codex's out-of-process server
      // both use: the flag threaded into the registry builder.
      expect(offered(getSessionToolDefs({ includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback })))
        .toBe(false);
      expect(getSessionToolRegistry({ includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback }).has(NAME))
        .toBe(false);
    } finally {
      process.env[FLAG_ENV] = '1';
    }
  });

  it('is on no deny path in ask or allow-all mode — a smoke check, NOT evidence of a grant: both modes allow every non-denied tool, flag on or off', () => {
    for (const mode of ['default', 'bypassPermissions'] as const) {
      expect(shouldAllowToolInMode(toolName, input, mode).allowed).toBe(true);
      // Named so the next reader does not mistake the row above for a grant:
      // an invented tool name answers identically here.
      expect(shouldAllowToolInMode(`${toolName}_x`, input, mode).allowed).toBe(true);
    }
  });

  it('does not require a permission prompt in ask mode (unprompted is this mode\'s default for every tool, so this too is a smoke check)', () => {
    const result = shouldAllowToolInMode(toolName, input, 'default');
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.requiresPermission).toBeFalsy();
    }
  });
});
