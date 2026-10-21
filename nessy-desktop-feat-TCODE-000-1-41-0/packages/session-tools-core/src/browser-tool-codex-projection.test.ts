/**
 * P6.27 — the claim was "the built-in browser is unreachable from a codex
 * session BY OMISSION FROM A LIST, not by architecture". Measured at HEAD, and
 * REFUTED: there is no list an entry could be added to that produces a working
 * browser on codex, and one of the four missing pieces is a permission gate.
 *
 * This file pins the refutation, because the claim is the kind that a grep
 * re-manufactures: `browser_tool` really does sit in
 * `SESSION_TOOLS_REQUIRING_HOST_CALLBACK` beside eight names the bridge now
 * carries, and it really does have no `visibility` restriction. Both are true
 * and neither is the reason.
 *
 * What the codex surface actually requires, measured through the enforcement
 * sites below rather than read off the tables:
 *
 * 1. `executionMode: 'registry'`, or membership in the backend-bridged set —
 *    and that set is lifted by `advisorConsultBridge` ALONE, so a lone entry
 *    would make the browser appear and disappear with the ADVISOR setting.
 * 2. A route on `HOST_CALLBACK_BRIDGE_ROUTES`. There is none for the browser,
 *    and that table is the whole channel: its own header says "Both ends import
 *    THIS object — the client builds its URLs from it and the host registers its
 *    handlers from it", so absence here is absence of the channel, not the
 *    identifier-probe's usual false negative.
 * 3. A spawn flag carrying the host's `browserToolEnabled` setting, for the
 *    reason `--advisor-consult` exists: `session-tools-core` has no dependency
 *    on `shared` and cannot read a host setting, and a disabled feature must be
 *    INVISIBLE rather than advertised.
 * 4. A host-side permission gate. This is the one that makes it a decision
 *    rather than a chore, and it is not visible from this package: on pi and
 *    claude the browser is decided PER COMMAND — `isBrowserToolNameOrAlias` +
 *    `isReadOnlyBrowserToolInput` in `shared/src/agent/mode-manager.ts` block
 *    state-changing commands in plan mode, and `shared/src/agent/core/pre-tool-use.ts`
 *    keys the "don't ask again" hash on the COMMAND so one approval of
 *    `click @e1` cannot blanket-approve `evaluate`. Codex reaches neither for
 *    an MCP tool call — and the naive grep says the opposite, which is why the
 *    measurement is written out: `runPreToolUseChecks` is 0 hits in
 *    `codex-agent.ts` (controls: pi 10, claude 2), while `shouldAllowToolInMode`
 *    IS 3 hits there, all inside `consultPermissionRules`, which answers only
 *    `execCommandApproval` and `applyPatchApproval` — the two approval kinds
 *    codex raises, neither produced by an MCP tool call. Projecting the tool
 *    as-is would ship arbitrary in-pane JS with no mode check and no prompt —
 *    exactly the situation the `Monitor` note in `tool-defs.ts` describes
 *    ("projecting Monitor would have shipped an ungated shell execution"),
 *    which T2 closed by BUILDING the gate first.
 *
 * So the omission was deliberate and its reason is recorded in three places
 * (`tool-defs.ts` above the host-callback set, `mode-types.ts`'s `blockedTools`
 * note, `runtime-switch-costs.ts`'s `appActions` row). What was NOT recorded is
 * that P3.13 dissolved the STRUCTURAL half of that reason — a backend tool can
 * cross now — leaving the gate as the live blocker. That is what this file adds.
 */
import { describe, expect, it } from 'bun:test';
import {
  SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK,
  SESSION_TOOL_DEFS,
  SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK,
  SESSION_TOOLS_REQUIRING_HOST_CALLBACK,
  getSessionToolNames,
} from './tool-defs.ts';
import { HOST_CALLBACK_BRIDGE_ROUTES } from './host-callback-bridge.ts';

const BROWSER = 'browser_tool';
const ADVISOR = 'advisor_consult';

const codex = () => getSessionToolNames({ externalStandaloneOnly: true });
const codexBridged = () => getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true });
const codexAdvised = () => getSessionToolNames({
  externalStandaloneOnly: true,
  hostCallbackBridge: true,
  advisorConsultBridge: true,
});

const defOf = (name: string) => SESSION_TOOL_DEFS.find(def => def.name === name);

describe('P6.27 — browser_tool on the codex surface', () => {
  it('is absent from every codex surface, bridge and advisor flag included', () => {
    expect(codex().has(BROWSER)).toBe(false);
    expect(codexBridged().has(BROWSER)).toBe(false);
    expect(codexAdvised().has(BROWSER)).toBe(false);
    // Positive control on the same rig: a backend tool CAN be here, so a `false`
    // above is a fact about the browser and not about the projection helper.
    expect(codexAdvised().has(ADVISOR)).toBe(true);
  });

  it('is excluded twice over, so removing either rule alone changes nothing', () => {
    // Rule 1 — the registry-only line in `getSessionToolDefs`.
    expect(defOf(BROWSER)?.executionMode).toBe('backend');
    // Rule 2 — the host-callback set, and it is in NEITHER bridged subset.
    expect(SESSION_TOOLS_REQUIRING_HOST_CALLBACK.has(BROWSER)).toBe(true);
    expect(SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK.has(BROWSER)).toBe(false);
    expect(SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK.has(BROWSER)).toBe(false);
    // `SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK` is the set the "one list entry"
    // reading points at, and it is the WRONG one: every member of it is a
    // registry tool, so it lifts rule 2 and never rule 1.
    for (const name of SESSION_TOOLS_BRIDGED_BY_HOST_CALLBACK) {
      expect(defOf(name)?.executionMode).toBe('registry');
    }
  });

  it('the only set that lifts a BACKEND tool is gated by the advisor flag alone', () => {
    // Measured through the filter, not read off the constant: nothing in the
    // backend-bridged set survives without `advisorConsultBridge`, and
    // everything in it survives with it. A `browser_tool` added to that set
    // would therefore be switched on and off by the ADVISOR setting — which is
    // why "add one list entry" is not a fix even before the missing route.
    for (const name of SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK) {
      expect(codexBridged().has(name)).toBe(false);
      expect(codexAdvised().has(name)).toBe(true);
    }
    expect([...codexAdvised()].filter(name => !codexBridged().has(name)))
      .toEqual([...SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK]);
  });

  it('carries no bridge route, which is the channel the projection would need', () => {
    const routes = Object.values(HOST_CALLBACK_BRIDGE_ROUTES) as string[];
    expect(routes.some(route => /browser/i.test(route))).toBe(false);
    expect(Object.keys(HOST_CALLBACK_BRIDGE_ROUTES).some(key => /browser/i.test(key))).toBe(false);
    // Positive control: the ONE backend tool that did cross has one, and that is
    // the shape a browser projection would have to reproduce.
    expect(routes).toContain('/advisor/consult');
  });

  it('is not withheld by a visibility restriction, so `pi-only` is not the story either', () => {
    // Stated because it is the other natural guess, and it is wrong: the tool is
    // on the claude surface. The exclusion is entirely the codex filter's.
    expect(defOf(BROWSER)?.visibility).toBeUndefined();
    expect(getSessionToolNames({}).has(BROWSER)).toBe(true);
    expect(getSessionToolNames({ projection: 'pi' }).has(BROWSER)).toBe(true);
  });
});
