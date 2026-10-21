/**
 * The per-origin browser trust store — P6.536, owner decision D9 = option 2.
 *
 * ## What was ungoverned
 *
 * The built-in browser navigated to any origin and attached an UNBOUNDED
 * DevTools debugger to it with no user decision and no record. Measured at
 * HEAD: `apps/electron/src/main/browser-cdp.ts`'s `ensureAttached()` calls
 * `webContents.debugger.attach('1.3')` with no per-origin check and no setting;
 * `siteAllowlist` / `domainAllowlist` / `perOriginApproval` resolved to **0**
 * files over `packages` + `apps` and `persistBrowsingSession` to **0**, against
 * `browserPane` in **50 files** as the positive control. The only control that
 * existed was `disableInAppBrowser` — all or nothing.
 *
 * ## Why the host owns this, on all three runtimes
 *
 * Native mechanism, verbatim from the sweep and confirmed: *"None. Anthropic's
 * is a hosted classifier plus a device-local trust store, and the pane is our
 * own Electron surface, so any control is host-supplied for all three."*
 * P2.373 additionally measured that codex does not act on its own
 * `in_app_browser` flag at all, so the gate had to be ours in any case.
 *
 * ## The three verdicts, and why the store keeps only two of them
 *
 * *Allow once* is deliberately NOT persisted — it lives in the caller's
 * session-scoped set and dies with the process. A "once" that survived a
 * restart would be a silent *always*, which is the one direction a trust
 * decision must never drift.
 *
 * ## Per SUBDOMAIN, and that is a decision, not an oversight
 *
 * The key is scheme + host + port, so `https://docs.example.com` and
 * `https://example.com` are two different trust decisions. A user approving a
 * documentation site has not approved everything the registrable domain can
 * host, and the whole value of the record is that it answers *which origins did
 * this session touch* with the precision the user actually granted.
 *
 * ## Two gates, one store, one lane
 *
 * Navigation and the full-CDP attach are separate grants over the same origin —
 * reading a page and driving its DevTools are different powers — and they are
 * stored as separate fields so an origin can be browsable without being
 * debuggable. They share one store because the per-site card and the CDP grant
 * must read one list; two stores would let the card show a state the gate does
 * not enforce.
 *
 * ## Not in this row
 *
 * Option 3 (a classifier band over external-origin write actions, plus a
 * browsing-session persistence choice) is the destination and is explicitly out
 * of scope: a band with no origin record has nothing to attach a verdict to.
 * The operator half is **P6.338** — a managed navigation allowlist — and this
 * module is shaped so that list can be consulted ahead of the stored verdict
 * without changing any caller.
 *
 * Zero imports, for the reason its neighbours state: the reader includes the
 * renderer, and a transitive `node:` import breaks the Vite build.
 */

/** What a person chose when the card asked. */
export type BrowserTrustVerdict = 'allow-once' | 'always-allow' | 'deny';

/** Which power was being asked for. */
export type BrowserTrustGate = 'navigation' | 'cdp';

/** What a gate does with a request, before anyone is asked. */
export type BrowserTrustDecision = 'allow' | 'deny' | 'ask';

/** The persisted half of one origin's record. `allow-once` is never in here. */
export interface BrowserOriginTrustRecordV1 {
  navigation?: 'always-allow' | 'deny';
  cdp?: 'always-allow' | 'deny';
  /** When the most recent persisted decision for this origin was made. */
  decidedAt?: number;
  /** When this origin was last visited, so the settings list can be ordered. */
  lastSeenAt?: number;
}

export interface BrowserOriginTrustStateV1 {
  version: 1;
  origins: Record<string, BrowserOriginTrustRecordV1>;
}

export const EMPTY_BROWSER_ORIGIN_TRUST: BrowserOriginTrustStateV1 = { version: 1, origins: {} };

/**
 * Origins that are never asked about, because asking would be theatre.
 *
 * `about:` and the empty page are the pane's own idle state, and a `data:` or
 * `blob:` URL carries no origin to record a verdict against. None of them is an
 * egress path, and a card over `about:blank` would train the user to click
 * Allow without reading.
 */
const UNGATED_SCHEMES = new Set(['about:', 'data:', 'blob:', 'chrome:', 'devtools:']);

/**
 * The trust key for a URL: `scheme://host[:port]`, or `undefined` for a URL
 * that is not gated at all.
 *
 * `undefined` means "do not ask and do not record", and is returned for the
 * ungated schemes above and for anything that will not parse. An unparseable
 * URL cannot be navigated to either, so refusing to invent a key for it is not
 * a hole — the navigation fails on its own.
 */
export function browserTrustOriginOf(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (UNGATED_SCHEMES.has(parsed.protocol)) return undefined;
  // `file:` HAS no host, and a file URL is local rather than egress — but it is
  // still a page the debugger could be attached to, so it gets one key of its
  // own rather than being ungated.
  if (parsed.protocol === 'file:') return 'file://';
  if (!parsed.host) return undefined;
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * What a gate should do about this origin, given what is stored and what was
 * allowed once in this process.
 *
 * `ask` is the default for anything unknown, which is the whole row: today's
 * answer was an unconditional `allow` on both gates.
 *
 * A `deny` outranks a session grant. Allow-once is a grant the user gave before
 * a later decision; the later decision is the one that stands.
 */
export function resolveBrowserTrust(
  state: BrowserOriginTrustStateV1 | undefined,
  sessionGrants: ReadonlySet<string> | undefined,
  origin: string,
  gate: BrowserTrustGate,
): BrowserTrustDecision {
  const stored = state?.origins?.[origin]?.[gate];
  if (stored === 'deny') return 'deny';
  if (stored === 'always-allow') return 'allow';
  if (sessionGrants?.has(sessionGrantKey(origin, gate))) return 'allow';
  return 'ask';
}

/** The key an allow-once grant is held under, so the two gates stay separate. */
export function sessionGrantKey(origin: string, gate: BrowserTrustGate): string {
  return `${gate}:${origin}`;
}

export interface BrowserTrustApplication {
  /** The persisted state after the decision. Unchanged for `allow-once`. */
  state: BrowserOriginTrustStateV1;
  /** Whether {@link BrowserTrustApplication.state} needs writing to disk. */
  persisted: boolean;
  /** The session-scoped grant to add, if any. */
  sessionGrant?: string;
}

/**
 * Record a person's answer.
 *
 * `allow-once` touches no persisted field at all — not even `decidedAt` — so a
 * store read back after a restart cannot tell a once-allowed origin from one
 * never visited. That is intentional: it is the only shape in which "once"
 * cannot decay into "always".
 */
export function applyBrowserTrustDecision(
  state: BrowserOriginTrustStateV1 | undefined,
  origin: string,
  gate: BrowserTrustGate,
  verdict: BrowserTrustVerdict,
  now: number = Date.now(),
): BrowserTrustApplication {
  const base = normalizeBrowserOriginTrust(state);
  if (verdict === 'allow-once') {
    return { state: base, persisted: false, sessionGrant: sessionGrantKey(origin, gate) };
  }
  const previous = base.origins[origin] ?? {};
  return {
    state: {
      version: 1,
      origins: { ...base.origins, [origin]: { ...previous, [gate]: verdict, decidedAt: now } },
    },
    persisted: true,
  };
}

/**
 * Note that this origin was visited, for the settings list's ordering and for
 * the row's *"which origins did this session touch"*.
 *
 * Records the visit ONLY for an origin that already has a record — a bare
 * `lastSeenAt` for every origin ever loaded would turn the trust store into a
 * browsing history on disk, which is a thing nobody asked for and a thing this
 * row must not accidentally ship.
 */
export function noteBrowserOriginSeen(
  state: BrowserOriginTrustStateV1 | undefined,
  origin: string,
  now: number = Date.now(),
): BrowserTrustApplication {
  const base = normalizeBrowserOriginTrust(state);
  const previous = base.origins[origin];
  if (!previous) return { state: base, persisted: false };
  return {
    state: { version: 1, origins: { ...base.origins, [origin]: { ...previous, lastSeenAt: now } } },
    persisted: true,
  };
}

/**
 * Revoke every stored verdict for one origin, which is what "revocable from
 * settings" means: the origin goes back to `ask` on both gates rather than to
 * `deny`. Revoking a permission is not the same as refusing it.
 */
export function revokeBrowserOriginTrust(
  state: BrowserOriginTrustStateV1 | undefined,
  origin: string,
): BrowserOriginTrustStateV1 {
  const base = normalizeBrowserOriginTrust(state);
  if (!(origin in base.origins)) return base;
  const origins = { ...base.origins };
  delete origins[origin];
  return { version: 1, origins };
}

function isVerdictField(value: unknown): value is 'always-allow' | 'deny' {
  return value === 'always-allow' || value === 'deny';
}

/**
 * Read a state document back, dropping anything unrecognised.
 *
 * A trust file is on disk and can be hand-edited. Every unreadable field falls
 * back to ABSENT, which resolves to `ask` — the conservative direction, and the
 * one `managed-settings.md#keys-that-fail-closed` takes for an invalid value.
 * A corrupt file therefore costs the user a prompt, never a silent grant.
 */
export function normalizeBrowserOriginTrust(raw: unknown): BrowserOriginTrustStateV1 {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_BROWSER_ORIGIN_TRUST;
  const rawOrigins = (raw as { origins?: unknown }).origins;
  if (typeof rawOrigins !== 'object' || rawOrigins === null || Array.isArray(rawOrigins)) {
    return EMPTY_BROWSER_ORIGIN_TRUST;
  }
  const origins: Record<string, BrowserOriginTrustRecordV1> = {};
  for (const [origin, entry] of Object.entries(rawOrigins as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record: BrowserOriginTrustRecordV1 = {};
    const { navigation, cdp, decidedAt, lastSeenAt } = entry as Record<string, unknown>;
    if (isVerdictField(navigation)) record.navigation = navigation;
    if (isVerdictField(cdp)) record.cdp = cdp;
    if (typeof decidedAt === 'number' && Number.isFinite(decidedAt)) record.decidedAt = decidedAt;
    if (typeof lastSeenAt === 'number' && Number.isFinite(lastSeenAt)) record.lastSeenAt = lastSeenAt;
    // An entry with no verdict at all is not a record; it is noise.
    if (record.navigation || record.cdp) origins[origin] = record;
  }
  return { version: 1, origins };
}

export interface BrowserTrustListEntry extends BrowserOriginTrustRecordV1 {
  origin: string;
}

/**
 * The settings list: every origin with a stored verdict, most recently decided
 * first, so the thing the user just approved is the thing they can revoke.
 */
export function listBrowserOriginTrust(
  state: BrowserOriginTrustStateV1 | undefined,
): BrowserTrustListEntry[] {
  const base = normalizeBrowserOriginTrust(state);
  return Object.entries(base.origins)
    .map(([origin, record]) => ({ origin, ...record }))
    .sort((a, b) =>
      (b.decidedAt ?? 0) - (a.decidedAt ?? 0) || a.origin.localeCompare(b.origin));
}
