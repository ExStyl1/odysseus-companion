import type { LocalToolCall, LocalToolRuntimeOptions } from './types.ts';

export interface LocalToolPermissionDecision {
  allowed: boolean;
  reason?: string;
}

type PendingPermission = {
  resolve: (allowed: boolean) => void;
};

export class LocalToolPermissionGate {
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  constructor(private readonly options: Pick<LocalToolRuntimeOptions, 'permissionManager' | 'onPermissionRequest'>) {}

  async check(call: LocalToolCall): Promise<LocalToolPermissionDecision> {
    const decision = this.options.permissionManager.evaluateToolCall(
      call.permission.toolName,
      call.permission.input,
    );

    if (!decision.allowed) {
      return { allowed: false, reason: decision.reason };
    }

    if (!decision.requiresPermission) {
      return { allowed: true };
    }

    if (!this.options.onPermissionRequest) {
      return { allowed: false, reason: 'Permission required but no permission UI is available' };
    }

    const requestId = call.permissionRequestId ?? `local-tool-${call.id}`;
    const allowed = await new Promise<boolean>((resolvePermission) => {
      this.pendingPermissions.set(requestId, { resolve: resolvePermission });
      this.options.onPermissionRequest?.({
        requestId,
        toolName: call.permission.toolName,
        command: call.permission.command,
        description: decision.description ?? `${call.permission.toolName} requires approval`,
        type: call.permission.type,
      });
    });

    return allowed ? { allowed: true } : { allowed: false, reason: 'Permission denied' };
  }

  respondToPermission(requestId: string, allowed: boolean): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve(allowed);
  }
}
