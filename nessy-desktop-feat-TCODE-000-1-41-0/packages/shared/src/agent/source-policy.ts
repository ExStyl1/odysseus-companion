/**
 * Source action policy (freestanding) — UA9.1.
 *
 * Copied and adapted from craft-agents-oss `v0.13.4:packages/shared/src/agent/source-policy.ts`
 * (Apache-2.0). The endpoint and tool rules that decide whether a source call is read-only or
 * allowlisted, or needs a human's approval, extracted out of `shouldPromptInAskMode`'s MCP and
 * API arms (`core/pre-tool-use.ts`) so a caller that is not the pre-tool hook — the Pages action
 * broker (UA9.2), and any later host service — evaluates the SAME rules instead of
 * re-implementing them. `shouldPromptInAskMode` delegates here.
 *
 * Adapted from upstream in three places, each a rule this fork already had at the extraction and
 * that the extraction must not lose:
 *  - **MCP probe mode.** Upstream asks `shouldAllowToolInMode(..., 'safe')`. Ours asks `'plan'`
 *    with `mutationProbe: true` (F1.1050 — `explore`, our old spelling of upstream's `safe`, is
 *    retired; the option keeps explore's browser verdict) and passes `permissionsContext`, so a
 *    workspace's or source's `allowedMcpPatterns` still count as read-only.
 *  - **API rule scope.** `isApiEndpointAllowed` takes the API tool's own name (F1.1152): a rule
 *    compiled from a source's `permissions.json` reaches only that source's `api_<slug>` tool. A
 *    caller that omits `apiToolName` gets the workspace-level rules only — source rules then
 *    never allow (fail closed), never apply to every source.
 *  - **Descriptions.** Byte-identical to the hook's card text (`MCP: <server>/<tool>`,
 *    `<METHOD> <path>`), so a broker's audit line and the chat card name a call the same way.
 *
 * NOT part of this module, by design (as upstream): session-scoped whitelists ("approved
 * earlier in this session") belong to the per-session PermissionManager and stay in the hook;
 * so do the mode-dependent allowances the hook layers on top (deferred-tool discovery and load,
 * F1.296 / F1.997; a session tool whose one effect is a write inside the roots, F1.526) — none of
 * those is a property of a SOURCE call, and a broker acting for a page has neither a session
 * whitelist nor a permission mode.
 */

import { isApiEndpointAllowed, shouldAllowToolInMode } from './mode-manager.ts';
import type { PermissionsContext } from './permissions-config.ts';

export type SourceActionPolicyDecision =
  | { decision: 'allow'; reason: 'read-only' | 'endpoint-allowlisted' }
  | { decision: 'requires-approval'; description: string };

/**
 * API-source endpoint policy:
 * - GET (and a call naming no method) is always allowed — read-only by convention;
 * - a mutation is allowed when it matches an `allowedApiEndpoints` rule of the merged
 *   permissions config that reaches `apiToolName` (F1.1152);
 * - everything else requires approval.
 *
 * @param apiToolName - the API tool the call goes through (`api_<slug>`, or an
 *   `mcp__<server>__api_<slug>` spelling); scopes a source's own rules to that source.
 */
export function evaluateApiEndpointPolicy(
  method: string | undefined,
  path: string | undefined,
  permissionsContext?: PermissionsContext,
  apiToolName?: string,
): SourceActionPolicyDecision {
  const upperMethod = (method || 'GET').toUpperCase();

  if (upperMethod === 'GET') {
    return { decision: 'allow', reason: 'read-only' };
  }

  if (isApiEndpointAllowed(upperMethod, path, permissionsContext, apiToolName)) {
    return { decision: 'allow', reason: 'endpoint-allowlisted' };
  }

  return { decision: 'requires-approval', description: `${upperMethod} ${path || ''}` };
}

/**
 * MCP tool policy: a call that a read-only mode would refuse is a mutation and requires
 * approval; anything the read-only probe allows is read-only.
 *
 * @param proxyToolName - the full proxy tool name (`mcp__{slug}__{tool}`)
 */
export function evaluateMcpToolPolicy(
  proxyToolName: string,
  input: Record<string, unknown>,
  options?: { plansFolderPath?: string; permissionsContext?: PermissionsContext },
): SourceActionPolicyDecision {
  const probe = shouldAllowToolInMode(proxyToolName, input, 'plan', {
    plansFolderPath: options?.plansFolderPath,
    permissionsContext: options?.permissionsContext,
    mutationProbe: true,
  });

  if (probe.allowed) {
    return { decision: 'allow', reason: 'read-only' };
  }

  const serverAndTool = proxyToolName.replace('mcp__', '').replace(/__/g, '/');
  return { decision: 'requires-approval', description: `MCP: ${serverAndTool}` };
}
