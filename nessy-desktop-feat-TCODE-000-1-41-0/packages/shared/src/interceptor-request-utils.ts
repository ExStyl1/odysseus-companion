/**
 * Resolve method/body/headers from fetch(input, init), including Request inputs.
 *
 * F1.565 — the returned init also carries the caller's abort `signal`: init's,
 * else the Request's own, the order `new Request(input, init)` applies. The
 * interceptor's adapter path calls the real fetch with a STRING url and this
 * init, so a signal left out here reached neither argument: an abort cancelled
 * nothing and the upstream stream stayed open (measured 2026-09-24,
 * `unified-network-interceptor.request-abort.test.ts`). The Request's other
 * options (`redirect`, `keepalive`, `credentials`, …) are still not carried;
 * a provider POST sets none of them.
 */
export async function resolveRequestContext(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ bodyStr?: string; normalizedInit: RequestInit }> {
  const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;

  // Prefer explicit init body (already detached from Request stream)
  if (typeof init?.body === 'string') {
    const normalizedInit = signal === init.signal ? init : { ...init, signal };
    return { bodyStr: init.body, normalizedInit };
  }

  // Fallback: parse Request body when caller used fetch(new Request(...))
  if (input instanceof Request) {
    try {
      const bodyStr = await input.clone().text();
      const normalizedInit: RequestInit = {
        method: init?.method ?? input.method,
        headers: init?.headers ?? input.headers,
        body: init?.body ?? bodyStr,
        ...(signal ? { signal } : {}),
      };
      return { bodyStr, normalizedInit };
    } catch {
      // Ignore body read errors — interception will be skipped
    }
  }

  return { bodyStr: undefined, normalizedInit: init ?? {} };
}
