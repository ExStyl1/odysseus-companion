import type { MonitorStartInput, SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface MonitorArgs {
  command?: string;
  ws?: { url: string; protocols?: string[] };
  description?: string;
  timeout_ms?: number;
  persistent?: boolean;
}

/** Documented default deadline for a non-persistent watch. */
export const MONITOR_DEFAULT_TIMEOUT_MS = 300_000;
/**
 * Documented maximum. Above-max values CLAMP rather than reject: the docs give
 * a max, and the existing timeout surfaces in this repo clamp, so a monitor
 * behaves like every other bounded timeout here.
 */
export const MONITOR_MAX_TIMEOUT_MS = 3_600_000;

function resolveTimeoutMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MONITOR_DEFAULT_TIMEOUT_MS;
  const rounded = Math.floor(value);
  if (rounded <= 0) return MONITOR_DEFAULT_TIMEOUT_MS;
  return Math.min(rounded, MONITOR_MAX_TIMEOUT_MS);
}

export async function handleMonitor(
  ctx: SessionToolContext,
  args: MonitorArgs
): Promise<ToolResult> {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  const wsUrl = typeof args.ws?.url === 'string' ? args.ws.url.trim() : '';
  // Exactly one source. Both or neither is an input error, never a silent
  // preference for one of them.
  if ((command.length > 0) === (wsUrl.length > 0)) {
    return errorResponse('Monitor requires exactly one of `command` or `ws`.');
  }

  const description = typeof args.description === 'string' ? args.description.trim() : '';
  if (!description) {
    return errorResponse('Monitor requires a non-empty `description`.');
  }

  if (!ctx.monitor) {
    return errorResponse('Monitor is not available in this context.');
  }

  const persistent = args.persistent === true;
  const input: MonitorStartInput = {
    description,
    timeoutMs: resolveTimeoutMs(args.timeout_ms),
    persistent,
    ...(command
      ? { command }
      : {
          ws: {
            url: wsUrl,
            ...(Array.isArray(args.ws?.protocols) && args.ws.protocols.length > 0
              ? { protocols: [...args.ws.protocols] }
              : {}),
          },
        }),
  };

  try {
    const started = await ctx.monitor.start(input);
    const result = successResponse([
      `Started monitor`,
      `taskId: ${started.taskId}`,
      `timeoutMs: ${started.timeoutMs}`,
      ...(started.persistent ? ['persistent: true'] : []),
      'Events arrive as task notifications. Stop it with ProcessStop.',
    ].join('\n'));
    result.structuredContent = {
      taskId: started.taskId,
      timeoutMs: started.timeoutMs,
      ...(started.persistent ? { persistent: true } : {}),
    };
    return result;
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : String(error));
  }
}
