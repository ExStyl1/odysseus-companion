import type { AskUserAnswer, AskUserPermissionRequest } from '@nessy-agent/core/types';
import type { SessionKey } from '@nessy-agent/shared/sessions/session-key';
import { validateAskUser, validateAskUserAnswer, type PendingAskUser, type PendingAskUserInput } from './vendor/rpiv-interactions/ask-user-reducer.ts';

export class AskUserService {
  private pendingRequest?: PendingAskUser;
  private settle?: { resolve: (answer: AskUserAnswer) => void; reject: (error: Error) => void };
  private timeout?: ReturnType<typeof setTimeout>;
  private removeAbort?: () => void;
  private reprojectedRequestId?: string;
  constructor(
    readonly sessionKey: SessionKey,
    private readonly persist?: (pending: PendingAskUser | undefined) => void | Promise<void>,
    initial?: PendingAskUser,
    private readonly onTerminal?: (requestId: string) => void,
  ) { this.pendingRequest = initial && structuredClone(initial); }
  pending(): PendingAskUser | undefined { return this.pendingRequest && structuredClone(this.pendingRequest); }
  /**
   * `minOptions` is the caller's explicit option floor, defaulting to the
   * `ask_user` tool's documented 2. Only the MCP elicitation acknowledgement
   * passes 1 — see {@link validateAskUser}.
   */
  async request(request: PendingAskUserInput, publish: (request: PendingAskUser) => void, options: { headless?: boolean; signal?: AbortSignal; minOptions?: number } = {}): Promise<AskUserAnswer> {
    if (this.pendingRequest) throw new Error('pending-request-exists');
    validateAskUser(request, { minOptions: options.minOptions });
    if (options.headless) throw new Error('ask_user_headless_unavailable');
    if (options.signal?.aborted) throw new Error('aborted');
    this.pendingRequest = { schemaVersion: 1, ...structuredClone(request) };
    this.reprojectedRequestId = undefined;
    const promise = new Promise<AskUserAnswer>((resolve, reject) => {
      this.settle = { resolve, reject };
      const cancel = () => { void this.reject(request.requestId, 'aborted').catch(error => this.detachWaiter(error)); };
      options.signal?.addEventListener('abort', cancel, { once: true });
      this.removeAbort = () => options.signal?.removeEventListener('abort', cancel);
      // askUserQuestionTimeout expiry (settings.md): auto-continue with the
      // selections made so far plus an away note — NEVER a tool error. With
      // the default ("never") no timeoutMs travels here and no timer exists.
      if (request.timeoutMs) this.timeout = setTimeout(() => { void this.autoContinue(request.requestId).catch(error => this.detachWaiter(error)); }, request.timeoutMs);
    });
    try {
      await this.persist?.(this.pending());
      if (options.signal?.aborted) { await this.reject(request.requestId, 'aborted'); return promise; }
      publish(structuredClone(this.pendingRequest));
      return promise;
    } catch (error) {
      const original = error;
      void promise.catch(() => {});
      try {
        await this.persist?.(undefined);
        this.detachWaiter(original);
        this.clear();
      } catch (rollback) {
        this.detachWaiter(original);
        throw new AggregateError([original, rollback], 'ask_user request rollback failed');
      }
      throw original;
    }
  }
  async answer(requestId: string, answer: AskUserAnswer): Promise<void> {
    const pending = this.pendingRequest;
    if (!pending || pending.requestId !== requestId) throw new Error('unknown-request');
    validateAskUserAnswer(pending, answer);
    await this.persist?.(undefined);
    if (!this.settle) { this.clear(); return; }
    const { resolve } = this.take(requestId);
    resolve(answer);
  }
  async cancel(requestId: string): Promise<void> { await this.reject(requestId, 'cancelled'); }
  reproject(publish: (request: PendingAskUser) => void): void {
    const pending = this.pending();
    if (!pending || this.reprojectedRequestId === pending.requestId) return;
    publish(pending);
    this.reprojectedRequestId = pending.requestId;
  }
  dispose(reason = 'session-disposed'): void {
    const settle = this.settle;
    this.clear();
    settle?.reject(new Error(reason));
  }
  private async reject(requestId: string, reason: string): Promise<void> {
    if (!this.pendingRequest || this.pendingRequest.requestId !== requestId) throw new Error('unknown-request');
    await this.persist?.(undefined);
    if (!this.settle) { this.clear(); return; }
    const { reject } = this.take(requestId);
    reject(new Error(reason));
  }

  /**
   * Expiry settlement for a configured askUserQuestionTimeout: RESOLVES the
   * waiting tool call with an auto-continued batched answer (empty selections
   * here — a renderer showing the card submits its own selections at the
   * countdown's end through the ordinary answer path, which wins if first).
   */
  private async autoContinue(requestId: string): Promise<void> {
    if (!this.pendingRequest || this.pendingRequest.requestId !== requestId) throw new Error('unknown-request');
    await this.persist?.(undefined);
    if (!this.settle) { this.clear(); return; }
    const { resolve } = this.take(requestId);
    resolve({ type: 'batched', answers: {}, autoContinued: true });
  }
  private take(requestId: string): NonNullable<AskUserService['settle']> {
    if (!this.pendingRequest || this.pendingRequest.requestId !== requestId || !this.settle) throw new Error('unknown-request');
    const settle = this.settle;
    this.clear();
    return settle;
  }
  private detachWaiter(error: unknown): void {
    const settle = this.settle;
    this.settle = undefined;
    this.removeAbort?.();
    this.removeAbort = undefined;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    if (settle) {
      settle.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private clear(): void {
    const requestId = this.pendingRequest?.requestId;
    this.pendingRequest = undefined;
    this.reprojectedRequestId = undefined;
    this.settle = undefined;
    this.removeAbort?.();
    this.removeAbort = undefined;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    if (requestId) this.onTerminal?.(requestId);
  }
}
