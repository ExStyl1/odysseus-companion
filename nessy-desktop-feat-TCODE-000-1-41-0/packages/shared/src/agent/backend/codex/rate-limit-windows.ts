/**
 * F1.7 (origin D1.77) — codex's OWN usage windows, read through codex's native
 * account surface, for a session codex itself reports a ChatGPT account on.
 *
 * ## Native-first, clause 1: the runtime has the mechanism, the host supplies the reader
 *
 * OWNER 2026-09-18 ~16:40, item 3, build (b), the SUBSCRIPTION half: *"a personal
 * subscription card uses the subscription's own windows through
 * `account/rateLimits/read` + `account/rateLimits/updated`"*. Both are codex's
 * (`packages/codex-protocol/generated/v2/GetAccountRateLimitsResponse.ts`,
 * `AccountRateLimitsUpdatedNotification.ts`, `RateLimitSnapshot.ts`,
 * `RateLimitWindow.ts`, `CreditsSnapshot.ts`); nothing here computes a window.
 *
 * ## The account gate, and why it is asked FIRST
 *
 * Measured 2026-09-11 on the shipped `codex-app-server` behind this fork's
 * loopback adapter (C4.28, `CodexAgent.describeQuota`'s docblock):
 * `account/rateLimits/read` answers `-32600 codex account authentication
 * required` while `account/read` answers `{ account: null }`. So the cheap,
 * always-answerable question goes first, and the windows are requested ONLY
 * when codex names a `chatgpt` account — a call that cannot succeed is never
 * made, which is the verdict C4.28 pinned ("an error must not render as a
 * budget"), kept rather than deleted. An `apiKey` or `amazonBedrock` account
 * has no ChatGPT windows either, so it is treated as no subscription.
 *
 * ## What renders, and what is never derived
 *
 * - each window's `usedPercent`, its length (`windowDurationMins`) and its
 *   reset (`resetsAt`, unit-normalised by `readPublishedUsageLimitReset`, the
 *   one reader this repo has for a server-published reset);
 * - `ordinaryUsageAllowed` as the VERDICT, printed only when codex states it:
 *   the generated field says *"Null means unavailable; clients must not infer
 *   recovery from percentages or reset times"*, so a null prints nothing and a
 *   percentage never becomes "you are fine";
 * - `rateLimitReachedType`, `spendControlReached`, the plan and the credits
 *   balance, verbatim, when present.
 *
 * ## The update notification is SPARSE
 *
 * `AccountRateLimitsUpdatedNotification`'s own docblock: *"Clients should merge
 * available values into the most recent `account/rateLimits/read` response …
 * Nullable account metadata may be unavailable in a rolling update and does
 * not clear a previously observed value."* {@link mergeCodexRateLimitUpdate} is
 * that merge, field by field.
 *
 * The narrow views are local rather than imported from
 * `@nessy-agent/codex-protocol`, the house style of `event-adapter.ts`: the
 * generated types are the contract, and what arrives is untyped JSON that the
 * readers below validate.
 */
import { readPublishedUsageLimitReset } from '../../usage-limit-reset.ts';

/** `RateLimitWindow`, narrowed. */
export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

/** `CreditsSnapshot`, narrowed. */
export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

/** The members of `RateLimitSnapshot` this reader renders. */
export interface CodexRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexCreditsSnapshot | null;
  planType: string | null;
  rateLimitReachedType: string | null;
  spendControlReached: boolean | null;
}

/** What `/quota` shows for a subscription session. */
export interface CodexAccountWindows {
  /** `ordinaryUsageAllowed` — codex's verdict; `null` means it stated none. */
  ordinaryUsageAllowed: boolean | null;
  snapshot: CodexRateLimitSnapshot;
}

export type CodexAccountWindowsRead =
  /** `account/read` answered, and names no ChatGPT account: nothing to read. */
  | { kind: 'no-account' }
  | { kind: 'windows'; windows: CodexAccountWindows }
  /** A request failed or answered a shape this reader cannot validate. */
  | { kind: 'unreadable'; reason: string };

/** The one method the reader needs from the app-server client. */
export interface CodexAccountRequester {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
}

/**
 * Each account request's ceiling. `AppServerClient.request` has none by default
 * (long operations share the channel), and a `/quota` answer must not wait on a
 * wedged app-server forever; ten seconds is the gateway read's own bound
 * (`NESTOR_QUOTA_TIMEOUT_MS`), so the two `/quota` answers wait alike.
 */
export const CODEX_ACCOUNT_READ_TIMEOUT_MS = 10_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readWindow(value: unknown): CodexRateLimitWindow | null {
  const raw = record(value);
  const usedPercent = finite(raw?.usedPercent);
  if (!raw || usedPercent === null) return null;
  return {
    usedPercent,
    windowDurationMins: finite(raw.windowDurationMins),
    resetsAt: finite(raw.resetsAt),
  };
}

function readCredits(value: unknown): CodexCreditsSnapshot | null {
  const raw = record(value);
  const hasCredits = flag(raw?.hasCredits);
  const unlimited = flag(raw?.unlimited);
  if (!raw || hasCredits === null || unlimited === null) return null;
  return { hasCredits, unlimited, balance: text(raw.balance) };
}

/** `RateLimitSnapshot` off untyped JSON; `null` when it is not an object. */
export function readCodexRateLimitSnapshot(value: unknown): CodexRateLimitSnapshot | null {
  const raw = record(value);
  if (!raw) return null;
  return {
    limitId: text(raw.limitId),
    limitName: text(raw.limitName),
    primary: readWindow(raw.primary),
    secondary: readWindow(raw.secondary),
    credits: readCredits(raw.credits),
    planType: text(raw.planType),
    rateLimitReachedType: text(raw.rateLimitReachedType),
    spendControlReached: flag(raw.spendControlReached),
  };
}

/**
 * Ask codex for this session's account, and for its windows ONLY when codex
 * names a ChatGPT account. Never throws: a failure is `unreadable`, carrying
 * the reason, so `/quota` can say it rather than render an error as a budget.
 */
export async function readCodexAccountWindows(
  client: CodexAccountRequester,
): Promise<CodexAccountWindowsRead> {
  let accountAnswer: unknown;
  try {
    accountAnswer = await client.request('account/read', { refreshToken: false }, { timeoutMs: CODEX_ACCOUNT_READ_TIMEOUT_MS });
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  const account = record(record(accountAnswer)?.account);
  if (!account || account.type !== 'chatgpt') return { kind: 'no-account' };

  let limitsAnswer: unknown;
  try {
    // A foreground read the user asked for, so the reset-credit DETAIL lookup
    // (a second backend call the generated param lets a client skip) is skipped
    // — this reader renders no reset-credit detail.
    limitsAnswer = await client.request(
      'account/rateLimits/read',
      { excludeResetCreditDetails: true },
      { timeoutMs: CODEX_ACCOUNT_READ_TIMEOUT_MS },
    );
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  const limits = record(limitsAnswer);
  const snapshot = readCodexRateLimitSnapshot(limits?.rateLimits);
  if (!limits || !snapshot) {
    return { kind: 'unreadable', reason: 'account/rateLimits/read answered without a rateLimits snapshot' };
  }
  return {
    kind: 'windows',
    windows: {
      ordinaryUsageAllowed: flag(limits.ordinaryUsageAllowed),
      // The account's own plan is the authority when the snapshot omits one.
      snapshot: { ...snapshot, planType: snapshot.planType ?? text(account.planType) },
    },
  };
}

/**
 * Merge one sparse `account/rateLimits/updated` into the last known windows.
 *
 * Every member the update carries replaces the previous one; every member it
 * leaves `null` keeps the previous value — the notification's own contract. The
 * VERDICT (`ordinaryUsageAllowed`) is not part of the update, so it is carried
 * over unchanged. Returns the previous windows untouched when the params carry
 * no snapshot at all.
 */
export function mergeCodexRateLimitUpdate(
  previous: CodexAccountWindows | null,
  params: unknown,
): CodexAccountWindows | null {
  const update = readCodexRateLimitSnapshot(record(params)?.rateLimits);
  if (!update) return previous;
  if (!previous) return { ordinaryUsageAllowed: null, snapshot: update };
  const before = previous.snapshot;
  return {
    ordinaryUsageAllowed: previous.ordinaryUsageAllowed,
    snapshot: {
      limitId: update.limitId ?? before.limitId,
      limitName: update.limitName ?? before.limitName,
      primary: update.primary ?? before.primary,
      secondary: update.secondary ?? before.secondary,
      credits: update.credits ?? before.credits,
      planType: update.planType ?? before.planType,
      rateLimitReachedType: update.rateLimitReachedType ?? before.rateLimitReachedType,
      spendControlReached: update.spendControlReached ?? before.spendControlReached,
    },
  };
}

function windowLabel(minutes: number | null): string {
  if (minutes === null) return 'Usage window';
  if (minutes === 300) return '5-hour window';
  if (minutes === 10_080) return 'Weekly window';
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

function formatWindow(window: CodexRateLimitWindow, formatInstant: (ms: number) => string): string {
  const used = Math.round(Math.min(100, Math.max(0, window.usedPercent)));
  const reset = readPublishedUsageLimitReset(window.resetsAt);
  const resets = reset.published ? ` (resets ${formatInstant(reset.resetsAtMs)})` : '';
  return `- ${windowLabel(window.windowDurationMins)}: ${used}% used${resets}`;
}

/**
 * Render the windows as one `/quota` answer. `formatInstant` defaults to an ISO
 * string, so the rendered text does not depend on the machine's locale.
 */
export function formatCodexAccountWindows(
  windows: CodexAccountWindows,
  formatInstant: (ms: number) => string = ms => new Date(ms).toISOString(),
): string {
  const { snapshot } = windows;
  const plan = snapshot.planType ? ` (ChatGPT plan: ${snapshot.planType})` : '';
  const lines = [`Codex usage windows${plan}:`];
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (window) lines.push(formatWindow(window, formatInstant));
  }
  if (!snapshot.primary && !snapshot.secondary) lines.push('- codex published no usage window for this account.');
  if (snapshot.credits) {
    const credits = snapshot.credits.unlimited
      ? 'unlimited'
      : snapshot.credits.balance ?? (snapshot.credits.hasCredits ? 'available' : 'none');
    lines.push(`- Credits: ${credits}`);
  }
  if (snapshot.rateLimitReachedType) lines.push(`- Limit reached: ${snapshot.rateLimitReachedType}`);
  if (snapshot.spendControlReached === true) lines.push('- Spend control reached.');
  if (windows.ordinaryUsageAllowed === true) lines.push('Codex reports ordinary usage is allowed.');
  if (windows.ordinaryUsageAllowed === false) lines.push('Codex reports ordinary usage is blocked.');
  return lines.join('\n');
}

/**
 * F1.569 (D1.189's pairing, closed on the ChatGPT (Codex) card) — the reset to
 * pair with a `usageLimitExceeded` stop, from the windows this session holds.
 *
 * The error that stops the turn carries no instant (`CodexErrorInfo` is a bare
 * string), but a session codex signed in to a ChatGPT account holds its windows
 * (a `/quota` read, or an `account/rateLimits/updated` push). The instant is the
 * LATEST future reset among the windows codex reports FULL (`usedPercent >=
 * 100`): usage returns only once every exhausted window has reset. A window that
 * is not full did not stop the turn, and a reset already past is no deadline, so
 * neither is named — `null`, and the caller keeps the no-reset sentence.
 *
 * Epoch milliseconds, through {@link readPublishedUsageLimitReset}, the one
 * reader this repo has for a server-published reset.
 */
export function codexUsageLimitWindowReset(
  windows: CodexAccountWindows | null,
  nowMs: number = Date.now(),
): number | null {
  if (!windows) return null;
  let latest: number | null = null;
  for (const window of [windows.snapshot.primary, windows.snapshot.secondary]) {
    if (!window || window.usedPercent < 100) continue;
    const reset = readPublishedUsageLimitReset(window.resetsAt);
    if (!reset.published || reset.resetsAtMs <= nowMs) continue;
    latest = latest === null ? reset.resetsAtMs : Math.max(latest, reset.resetsAtMs);
  }
  return latest;
}
