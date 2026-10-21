/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '@nestor/nessy-cli-core';
import {
  type RuntimePendingRequest,
  type RuntimeSessionControl,
  type RuntimeSessionPhase,
  type RuntimeSessionSource,
  type RuntimeSessionState,
  updateRuntimeStatusState,
} from '@nestor/nessy-cli-core';

const debugLogger = createDebugLogger('SESSION_STATUS');

/** Resolves the runtime.json path for the *current* session on every write. */
export type SessionStatusPathResolver = () => string;

const stableKey = (value: unknown): string => JSON.stringify(value) ?? '';

/**
 * Writes the `state` block of the session's runtime.json sidecar
 * (see `updateRuntimeStatusState` in core) on phase transitions.
 *
 * Writes are:
 * - **edge-triggered**: an identical consecutive state is not written again;
 * - **serialized** through an internal promise chain so read-modify-write
 *   calls never interleave;
 * - **best-effort**: failures are logged to the debug channel and never
 *   propagate into TUI control flow.
 *
 * The path is re-resolved on every write (`/clear` and `/resume` swap the
 * session id and Config rewrites the sidecar under the new one).
 */
export class SessionStatusReporter {
  private readonly resolvePath: SessionStatusPathResolver;
  private readonly source: RuntimeSessionSource | null;
  private phase: RuntimeSessionPhase | null = null;
  private pendingRequest: RuntimePendingRequest | null = null;
  private control: RuntimeSessionControl | null = null;
  private hasWritten = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    resolvePath: SessionStatusPathResolver,
    source?: RuntimeSessionSource,
  ) {
    this.resolvePath = resolvePath;
    this.source = source ?? null;
  }

  /**
   * Record a phase transition (and, for `waiting_input`, the request the
   * session is blocked on). Passing `null` clears any pending request.
   */
  setPhase(
    phase: RuntimeSessionPhase,
    pendingRequest: RuntimePendingRequest | null = null,
  ): void {
    this.enqueue(() => {
      if (
        this.hasWritten &&
        this.phase === phase &&
        stableKey(this.pendingRequest) === stableKey(pendingRequest)
      ) {
        return;
      }
      this.phase = phase;
      this.pendingRequest = pendingRequest;
      return this.writeState();
    });
  }

  /**
   * Advertise the external control channels associated with this session
   * (`control` block). Rides along with the next phase write when no phase
   * has been recorded yet.
   */
  setControl(control: RuntimeSessionControl | null): void {
    this.enqueue(() => {
      if (stableKey(this.control) === stableKey(control)) return;
      this.control = control;
      if (this.phase === null) return;
      return this.writeState();
    });
  }

  /** Resolves once every queued write has been attempted (test helper). */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private async writeState(): Promise<void> {
    if (this.phase === null) return;
    const state: RuntimeSessionState = {
      phase: this.phase,
      updated_at: Date.now() / 1000,
      ...(this.source ? { source: this.source } : {}),
      pending_request: this.pendingRequest,
      control: this.control,
    };
    const ok = await updateRuntimeStatusState(this.resolvePath(), state);
    if (ok) {
      this.hasWritten = true;
    } else {
      debugLogger.debug(
        'SessionStatus: runtime state update skipped (sidecar missing or unreadable)',
      );
    }
  }

  private enqueue(op: () => void | Promise<void>): void {
    this.writeChain = this.writeChain.then(op).catch((err: unknown) => {
      debugLogger.debug('SessionStatus: state write failed:', err);
    });
  }
}
