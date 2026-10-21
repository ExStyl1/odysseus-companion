/**
 * useCapabilityMcpTools (U3 + auto-peek)
 *
 * Driver for CapabilityMcpToolsSection. On detail open it fires ONE *peek*:
 * a pool-cache read that NEVER connects (opening a source page is not
 * connect-intent — the bank start policy). If the workspace pool is already
 * warm (since 1.12.0 chat sessions share the workspace pool, so a server a
 * chat uses is already connected) the tools appear immediately with no click.
 * A cold pool ('disconnected') falls back to the collapsed "Load tools"
 * affordance whose button fires the FULL (connecting) call. Other refusals
 * ('disabled'/'no-session'/'error') render exactly as before.
 *
 * The peek fires exactly once per capability (guarded by `run`'s stable
 * identity + a run-id token); it re-peeks when the capability key changes, and
 * (F1.1251) when the workspace's capabilities change. No polling, no retry loop.
 *
 * The result→state reducers are pure/exported so the mapping is unit-testable
 * without a DOM (this repo has no renderHook lib).
 */

import * as React from 'react'
import type {
  CapabilityCatalogChangedEvent,
  SafeCapabilityContextRef,
  SafeMcpToolsResult,
} from '@nessy-agent/shared/protocol/capabilities'
import type { CapabilityMcpToolsState } from './CapabilityMcpToolsSection'

/** Map a settled FULL (connecting) RPC result to the section's UI state. */
export function toMcpToolsState(result: SafeMcpToolsResult): CapabilityMcpToolsState {
  if (result.status === 'ok') return { status: 'ok', tools: result.tools }
  if (result.reason === 'error') return { status: 'error' }
  return { status: 'refused', reason: result.reason }
}

/**
 * Map a settled PEEK result to the section's UI state. Identical to
 * {@link toMcpToolsState} EXCEPT a 'disconnected' cold pool falls back to the
 * collapsed "Load tools" affordance rather than the 'disconnected' placeholder:
 * a peek never connects, so the user still needs the explicit Load click to
 * warm the pool. A warm pool ('ok') shows its tools immediately.
 */
export function toMcpPeekState(result: SafeMcpToolsResult): CapabilityMcpToolsState {
  if (result.status === 'refused' && result.reason === 'disconnected') {
    return { status: 'collapsed' }
  }
  return toMcpToolsState(result)
}

/**
 * F1.1251 — whether a `capabilities.CHANGED` event re-peeks the open page's tools. Pure.
 *
 * Only a change of the page's own workspace (a source or a built-in dp server
 * switched on or off moves its catalog), and never over a Load in flight: that
 * full call is the user's connect-intent, and a peek would supersede its result.
 */
export function repeeksOnCapabilityChange(
  event: CapabilityCatalogChangedEvent,
  workspaceId: string,
  state: CapabilityMcpToolsState,
): boolean {
  return event.workspaceId === workspaceId && state.status !== 'loading'
}

export interface UseCapabilityMcpToolsResult {
  state: CapabilityMcpToolsState
  load: () => void
  retry: () => void
}

export interface UseCapabilityMcpToolsOptions {
  /**
   * Auto-peek only once this is true — the caller confirms the capability is an
   * MCP source (known only after the detail loads), so a non-MCP detail never
   * fires a pointless RPC. Defaults to true.
   */
  enabled?: boolean
  /** Injectable RPC for tests; defaults to the preload bridge. */
  listMcpTools?: (
    context: SafeCapabilityContextRef,
    capabilityKey: string,
    peek?: boolean,
  ) => Promise<SafeMcpToolsResult>
}

export function useCapabilityMcpTools(
  context: SafeCapabilityContextRef,
  capabilityKey: string,
  options: UseCapabilityMcpToolsOptions = {},
): UseCapabilityMcpToolsResult {
  const enabled = options.enabled ?? true
  // Stabilize the RPC ref so `run` (and thus the peek effect) does not change
  // identity on every render — otherwise the auto-peek would re-fire endlessly.
  const injected = options.listMcpTools
  const listMcpTools = React.useMemo<
    (context: SafeCapabilityContextRef, capabilityKey: string, peek?: boolean) => Promise<SafeMcpToolsResult>
  >(
    () => injected ?? ((ctx, key, peek) => window.electronAPI.capabilities.listMcpTools(ctx, key, peek)),
    [injected],
  )
  const [state, setState] = React.useState<CapabilityMcpToolsState>({ status: 'collapsed' })
  // Monotonic token so a stale in-flight call (superseded by a capability
  // change, or a Load click fired while a peek was in flight) is dropped.
  const runIdRef = React.useRef(0)

  const run = React.useCallback((peek: boolean) => {
    const id = ++runIdRef.current
    // A peek stays quiet (keeps the collapsed affordance) until it resolves, so
    // a cold pool never flashes a skeleton. The full call shows the skeleton.
    if (!peek) setState({ status: 'loading' })
    void (async () => {
      let result: SafeMcpToolsResult
      try {
        result = await listMcpTools(context, capabilityKey, peek)
      } catch {
        result = { status: 'refused', reason: 'error' }
      }
      if (id !== runIdRef.current) return
      setState(peek ? toMcpPeekState(result) : toMcpToolsState(result))
    })()
  }, [context, capabilityKey, listMcpTools])

  // On mount / capability change: reset to collapsed so a new source never
  // shows a prior source's tools, then auto-fire ONE peek once enabled.
  React.useEffect(() => {
    setState({ status: 'collapsed' })
    if (enabled) run(true)
  }, [run, enabled])

  // F1.1251 — an open page re-reads its tools when its workspace's capabilities change, instead of keeping the
  // list it peeked on open until the page is re-opened. A peek, so it never connects.
  const stateRef = React.useRef(state)
  stateRef.current = state
  React.useEffect(() => {
    if (!enabled) return undefined
    return window.electronAPI.capabilities.onChanged((event) => {
      if (repeeksOnCapabilityChange(event, context.workspaceId, stateRef.current)) run(true)
    })
  }, [run, enabled, context.workspaceId])

  const load = React.useCallback(() => { run(false) }, [run])
  const retry = React.useCallback(() => { run(false) }, [run])

  return { state, load, retry }
}
