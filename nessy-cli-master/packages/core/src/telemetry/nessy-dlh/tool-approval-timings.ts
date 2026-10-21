// [nessy-fork] dlh-telemetry
// Тайминги аппрува по callId — для DLH-события `tool_call`.
// `sentAt` фиксируется при входе в `awaiting_approval`, `receivedAt`
// — при выходе из него (вне зависимости от итогового статуса).
// Вынесено из CoreToolScheduler чтобы не добавлять приватное поле в upstream-класс.
const timings = new Map<string, { sentAt?: number; receivedAt?: number }>();

export function trackApprovalSent(callId: string): void {
  timings.set(callId, { ...timings.get(callId), sentAt: Date.now() });
}

export function trackApprovalReceived(callId: string): void {
  timings.set(callId, { ...timings.get(callId), receivedAt: Date.now() });
}

export function getAndClearApprovalTiming(
  callId: string,
): { sentAt?: number; receivedAt?: number } | undefined {
  const timing = timings.get(callId);
  timings.delete(callId);
  return timing;
}
