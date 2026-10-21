/**
 * UA1.18 — the host side of `publish_artifact` / `list_artifacts` (OQ-18, OQ-22 (a)(b)(c)), as plain functions over
 * ports so the ORDER — the contract — is testable without a `SessionManager`:
 *
 *   unattended refusal → request checks (retention 1..30, the update target in THIS workspace's registry, one card
 *   at a time) → publish guard (UA1.17: credential floor, read floor, one read + sha256, scan) → normalise (UA1.16)
 *   → the host card → re-guard and compare the digest → the client (one POST, or one PUT) → the registry → audit.
 *
 * `SessionManager.publishArtifactForAgent` binds the ports (the card through `directPermissionResolvers`, the
 * client through `createTArtifactsClient`, the audit row through `recordSessionInfoEntry`) and is the closure every
 * runtime reaches — Pi and Claude in process, codex over `HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish`.
 *
 * ## The unattended predicate (defined ONCE: {@link artifactUnattendedReason}; UA6.2's `delete_page` takes it in)
 *
 * A card nobody can answer is refused before it is raised, with zero requests (OQ-22 (c)):
 * - `dontAsk` — the mode promises no prompt, and a publish without one is the thing the card exists to prevent;
 * - no interactive client — no connected window in the caller's workspace can show a confirmation
 *   (`CLIENT_CONFIRM_DIALOG`, which every Electron window advertises and no phone does);
 * - an automation, a schedule (any host-delivered task notification) or a Pi goal continuation started the turn;
 * - the caller is a subagent (claude/codex, from the tool call's origin) or a Pi child session (Agent/Workflow).
 * `bypassPermissions` is NOT on the list: the card is raised in every mode a person can answer.
 *
 * ## UA6.7 — Pages ride the SAME chain (no second publish door)
 *
 * `server-core/src/pages/page-publishing.ts` publishes a Page through {@link runArtifactPublish} with two optional
 * ports: `readSource` replaces the file guard with the page bundle's guard (the UA1.17 scan over the page's HTML AND
 * its snapshot, one buffer, hashed once — read before the card and again after it, exactly as a file is), and
 * `registrySource` records the row as a `'page'` (no source session, the page facet) and names the one update target
 * the page owns. Everything else — the request checks, the normaliser, the card payload, the re-check, the one
 * request, the registry write, the audit row — is this function's.
 */
import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import type { PermissionsContext } from '@nessy-agent/shared/agent';
import {
  ArtifactClientError,
  isTArtifactsUrl,
  resolveArtifactId,
  T_ARTIFACTS_ORIGIN,
  type ArtifactRecord,
  type TArtifactsClient,
} from '@nessy-agent/shared/artifacts/t-artifacts-client';
import { normalizeArtifact, type NormalizedArtifact } from '@nessy-agent/shared/artifacts/normalize';
import { guardArtifactFile, type PublishGuardPass, type PublishGuardResult } from '@nessy-agent/shared/artifacts/publish-guard';
import { readDpIdentity } from '@nessy-agent/shared/auth/dp';
import {
  ArtifactRegistryError,
  findArtifactRegistryEntry,
  listSessionArtifacts,
  recordArtifactPublish,
  recordArtifactUpdate,
  type ArtifactKind,
  type ArtifactPageFacet,
  type ArtifactRegistryEntry,
} from '@nessy-agent/shared/artifacts/registry';
import {
  PUBLISH_ARTIFACT_DEFAULT_RETENTION_DAYS,
  PUBLISH_ARTIFACT_MAX_RETENTION_DAYS,
  PUBLISH_ARTIFACT_MIN_RETENTION_DAYS,
  type ListArtifactsResult,
  type PublishArtifactInput,
  type PublishArtifactVerdict,
} from '@nessy-agent/session-tools-core';
import type { PermissionRequest } from '@nessy-agent/core/types';

export type ArtifactPublishCard = NonNullable<PermissionRequest['artifactPublish']>;

/**
 * How long a publish card waits for its answer before it resolves to a DENY (plan UA1.18 "a card that times out
 * resolves to deny"). 110 s, DECIDED (transparent, simple): inside the 120 s ceiling of the codex bridge client
 * (`host-callback-bridge-client.ts` `BRIDGE_TIMEOUT_MS`) and of the Pi descriptor (`external(...)` `timeoutMs`), so on
 * those paths the HOST decides and the model is told "declined" rather than meeting a transport timeout. Residue,
 * stated: codex's own MCP `tool_timeout_sec` defaults to 60 s (`learn.chatgpt.com/docs/extend/mcp.md`, weak tier), so
 * UA12.24 makes our writer always emit 121 s on `[mcp_servers.session]` (`CODEX_SESSION_TOOL_TIMEOUT_SEC`): a card
 * answered at any point of its 110 s decides on the host before codex's clock runs out; the audit row records it.
 */
export const PUBLISH_ARTIFACT_CARD_TIMEOUT_MS = 110_000;

/** The preview the card carries is capped for the wire; the bytes SENT are never capped by this. */
export const ARTIFACT_CARD_PREVIEW_LIMIT_BYTES = 512 * 1024;
/** "the first 40 source lines" (plan UA1.18). */
export const ARTIFACT_CARD_SOURCE_HEAD_LINES = 40;
/**
 * UA1.18 follow-up — the source excerpt is capped for the wire too: 40 lines of a single-line minified page are the
 * whole page (up to the guard's 16 MiB), which would ride the `permission_request` event a second time beside the
 * capped preview and render whole in the card's `<pre>`. A capped excerpt ends in `…`; the bytes SENT are never
 * capped by this. 64 KiB, DECIDED (transparent, simple): far more than 40 lines of any hand-written page.
 */
export const ARTIFACT_CARD_SOURCE_HEAD_LIMIT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// The unattended predicate
// ---------------------------------------------------------------------------

export type ArtifactUnattendedReason =
  | 'dont-ask'
  | 'no-interactive-client'
  | 'automation'
  | 'schedule'
  | 'goal-continuation'
  | 'subagent'
  | 'workflow-child';

/** What the host knows about the caller at the moment of the call. */
export interface ArtifactUnattendedFacts {
  permissionMode: string | undefined;
  interactiveClientAttached: boolean;
  /** What started the current turn, when the host started it rather than a person. */
  turnDispatchedBy?: 'automation' | 'schedule' | 'goal-continuation';
  /** The tool call came from a subagent of the session (claude/codex), not the session's own model turn. */
  calledFromSubagent: boolean;
  /** The session is a Pi child (Agent/Workflow) of another session. */
  isChildSession: boolean;
}

/** The predicate: the FIRST reason nobody can answer a card, or `null`. Pure; order is the refusal's wording. */
export function artifactUnattendedReason(facts: ArtifactUnattendedFacts): ArtifactUnattendedReason | null {
  if (facts.permissionMode === 'dontAsk') return 'dont-ask';
  if (facts.calledFromSubagent) return 'subagent';
  if (facts.isChildSession) return 'workflow-child';
  if (facts.turnDispatchedBy) return facts.turnDispatchedBy;
  if (!facts.interactiveClientAttached) return 'no-interactive-client';
  return null;
}

/**
 * The one clause per {@link ArtifactUnattendedReason} (UA12.61): the publish refusal below and the delete refusal
 * (`pages/tool-callbacks.ts` `pageDeleteUnattendedRefusal`) both embed it, so the two sentences cannot drift.
 * The `Record` over the union is the type-level half of the row's control — a reason added without a phrase
 * fails typecheck.
 */
export const UNATTENDED_WHY: Readonly<Record<ArtifactUnattendedReason, string>> = {
  'dont-ask': 'the session is in Don\'t ask mode, which shows no prompts',
  'no-interactive-client': 'no Nessy window is open on this workspace to show the confirmation',
  automation: 'this turn was started by an automation',
  schedule: 'this turn was started by a scheduled task or a background notification, not by the user',
  'goal-continuation': 'this turn is an automatic goal continuation',
  subagent: 'the call came from a subagent, not from the conversation with the user',
  'workflow-child': 'this session is a child agent of another session',
};

/** The sentence the model reads for an unattended refusal. */
export function artifactUnattendedRefusal(reason: ArtifactUnattendedReason): string {
  return `publish_artifact needs the user to approve a confirmation card, and ${UNATTENDED_WHY[reason]}, so nothing was `
    + 'published and no request was made. Offer the page in one line of text instead; the user can publish it from '
    + 'an open session.';
}

/**
 * UA12.54 — the sentence a PERSON reads for an unattended refusal (the preview Publish toast shows the verdict note
 * verbatim): it names the reason — the mode included — and asks for no model-only action ("Offer the page in one line
 * of text instead" is an instruction nobody can follow on their own click).
 */
export function artifactUnattendedUserRefusal(reason: ArtifactUnattendedReason): string {
  return `Nothing was published — ${UNATTENDED_WHY[reason]}.`;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type ArtifactAuditDecision =
  | 'approved'
  | 'denied'
  | 'refused-unattended'
  | 'refused-guard'
  | 'refused-request';

/** One host-written audit row: no content, no token (plan UA1.18 "audit"). */
export interface ArtifactAuditRecord {
  decision: ArtifactAuditDecision;
  action: 'create' | 'update';
  runtime: string;
  permissionMode: string;
  sourcePath: string;
  timestamp: string;
  sha256?: string;
  byteLength?: number;
  emailCount?: number;
  phoneCount?: number;
  scriptCount?: number;
  externalHosts?: readonly string[];
  retentionDays?: number;
  /** approved: the link; also the update target. */
  url?: string;
  /** approved but the service call failed: its kind (`needs-login`, `network`, …). */
  failure?: string;
  /** refused-*: the rule that refused (never a value from the file). */
  rule?: string;
}

/** The audit row's text — what `recordSessionInfoEntry` writes into the transcript (role `info`, never model-writable). */
export function formatArtifactAuditLine(record: ArtifactAuditRecord): string {
  const parts: string[] = [
    `decision: ${record.decision}${record.failure ? ` (service call failed: ${record.failure})` : ''}`,
    `action: ${record.action}`,
    `runtime: ${record.runtime}`,
    `mode: ${record.permissionMode}`,
    `file: ${record.sourcePath}`,
  ];
  if (record.sha256) parts.push(`sha256: ${record.sha256.slice(0, 16)}…`);
  if (record.byteLength !== undefined) parts.push(`size: ${record.byteLength} bytes`);
  if (record.emailCount !== undefined || record.phoneCount !== undefined) {
    parts.push(`scan: ${record.emailCount ?? 0} e-mail(s), ${record.phoneCount ?? 0} phone number(s)`);
  }
  if (record.scriptCount !== undefined) parts.push(`scripts: ${record.scriptCount}`);
  if (record.externalHosts !== undefined) {
    parts.push(`external hosts: ${record.externalHosts.length > 0 ? record.externalHosts.join(', ') : 'none'}`);
  }
  if (record.retentionDays !== undefined) parts.push(`retention: ${record.retentionDays} days`);
  if (record.rule) parts.push(`rule: ${record.rule}`);
  if (record.url) parts.push(`link: ${record.url}`);
  parts.push(`at: ${record.timestamp}`);
  return `Artifact publish audit — ${parts.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/** The answer to a raised card: `allowed`, or the sentence for why not (declined, timed out, cancelled). */
export interface ArtifactCardAnswer {
  allowed: boolean;
  refusal?: string;
}

export interface ArtifactPublishPorts {
  workspaceRoot: string;
  sessionId: string;
  /** For the audit row: `pi`, `claude`, `codex`, … */
  runtime: string;
  permissionMode: string;
  sessionCwd: string;
  sessionDir?: string;
  addedRoots: readonly string[];
  permissionsContext?: PermissionsContext | null;
  /** The predicate's answer for THIS call (null = attended). */
  unattendedReason(): ArtifactUnattendedReason | null;
  /** True while this session already waits on a publish card. */
  cardPending(): boolean;
  /** Raise the host card and wait for its answer (the port owns the pending flag, the count and the timeout). */
  raiseCard(card: ArtifactPublishCard): Promise<ArtifactCardAnswer>;
  createClient(): TArtifactsClient;
  audit(record: ArtifactAuditRecord): void;
  /**
   * UA12.52 — the registry just gained or changed a row, so the host pushes `artifacts:changed` to the workspace's
   * windows and an OPEN Published pages section reloads without its Retry button. Optional: a caller with no window
   * push (a test, a headless flow) omits it.
   */
  notifyArtifactChanged?(): void;
  /**
   * UA12.54 — the verdict is read by a PERSON (the preview Publish toast), not by the model: refusal sentences that
   * instruct the model become user wording (the unattended refusal names the reason, the mode included). The tool
   * path omits it. Residue, stated: the guard's and the normaliser's messages are shared with the model path and stay
   * as they are — they instruct whoever can act, and a person can act on them; the request-check refusals (retention
   * range, update target) cannot fire on the click path, whose input carries only the file path.
   */
  userFacing?: true;
  now?(): Date;
  /**
   * UA6.7 — the bytes, when they are not a file the session names (a Page's bundle): called before the card and
   * again after it, as the file guard is. Absent: `guardArtifactFile` over the roots above.
   */
  readSource?(): PublishGuardResult;
  /** UA6.7 — how the registry records the row, and the one update target the source owns (by artifact id). */
  registrySource?: {
    kind: ArtifactKind;
    sourceSessionId: string;
    sourcePath: string;
    page?: ArtifactPageFacet;
    /** The registry row this source may update — its own, even though it has no source session. */
    updateTargetId?: string;
  };
}

function refused(note: string): PublishArtifactVerdict {
  return { status: 'refused', note };
}

/**
 * "relative to its cwd where possible" — the registry's and the audit row's spelling of the file. `path` is the
 * guard's realpath, so the cwd is resolved too (a cwd reached through a symlink would otherwise never contain it).
 */
export function artifactSourcePath(sessionCwd: string, path: string): string {
  let base = sessionCwd;
  try {
    base = realpathSync.native(sessionCwd);
  } catch {
    // compared as given
  }
  const rel = relative(base, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

function decodeBasicEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&');
}

function capUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return { text, truncated: false };
  // Cut on a code-point boundary: drop continuation bytes at the cut.
  let end = limit;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

/** The most of a dp login the card names — beyond this it is truncated, not hidden. */
export const ARTIFACT_OWNER_LOGIN_LIMIT = 64;

/**
 * UA12.27 — the LAST KNOWN dp login the card's owner line names (P-UA-n-4): `readDpIdentity` reads the cached Nessy
 * Gateway credential, which can outlive or differ from dp's current session, while the publish itself is signed by a
 * live `dp auth print-token` — so the card says "last known as", never that this login signs it. Never throws —
 * a failed identity read costs the card its name, never the publish its path.
 */
export function artifactOwnerLogin(): string | undefined {
  try {
    const username = readDpIdentity()?.username.trim();
    if (!username) return undefined;
    return username.length > ARTIFACT_OWNER_LOGIN_LIMIT
      ? `${username.slice(0, ARTIFACT_OWNER_LOGIN_LIMIT)}…`
      : username;
  } catch {
    return undefined;
  }
}

/** The card's payload, from the guard's ONE buffer and its normalised form. */
export function buildArtifactPublishCard(input: {
  mode: 'create' | 'update';
  sourcePath: string;
  guard: PublishGuardPass;
  normalized: NormalizedArtifact;
  expiresAt: string | null;
  retentionDays?: number;
  url?: string;
  previous?: ArtifactRegistryEntry;
  ownerLogin?: string;
}): ArtifactPublishCard {
  const preview = capUtf8(input.normalized.content, ARTIFACT_CARD_PREVIEW_LIMIT_BYTES);
  const head = capUtf8(
    input.guard.text.split('\n').slice(0, ARTIFACT_CARD_SOURCE_HEAD_LINES).join('\n'),
    ARTIFACT_CARD_SOURCE_HEAD_LIMIT_BYTES,
  );
  return {
    mode: input.mode,
    sourcePath: input.sourcePath,
    contentType: input.normalized.contentType,
    title: decodeBasicEntities(input.normalized.title),
    emoji: input.normalized.emoji,
    byteLength: input.normalized.byteLength,
    lineCount: countLines(input.normalized.content),
    sha256: input.guard.sha256,
    serviceOrigin: T_ARTIFACTS_ORIGIN,
    ...(input.ownerLogin !== undefined ? { ownerLogin: input.ownerLogin } : {}),
    expiresAt: input.expiresAt,
    ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    previewContent: preview.text,
    previewTruncated: preview.truncated,
    sourceHead: head.truncated ? `${head.text}…` : head.text,
    scriptCount: input.normalized.policy.inlineScripts + input.normalized.policy.eventHandlerAttributes,
    externalHosts: [...input.normalized.policy.externalHosts],
    scanSentence: input.guard.scanSentence,
    emailCount: input.guard.counts.emails,
    phoneCount: input.guard.counts.phones,
    ...(input.previous
      ? {
          previous: {
            sha256: input.previous.contentDigest,
            ...(input.previous.byteLength !== undefined ? { byteLength: input.previous.byteLength } : {}),
            ...(input.previous.lineCount !== undefined ? { lineCount: input.previous.lineCount } : {}),
          },
        }
      : {}),
  };
}

function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * One `publish_artifact` call, start to finish. Never throws for a refusal: every outcome is a verdict with a
 * sentence, and every outcome writes exactly one audit row.
 */
export async function runArtifactPublish(
  ports: ArtifactPublishPorts,
  input: PublishArtifactInput,
): Promise<PublishArtifactVerdict> {
  const now = () => ports.now?.() ?? new Date();
  const action: 'create' | 'update' = input.url !== undefined ? 'update' : 'create';
  const base = {
    action,
    runtime: ports.runtime,
    permissionMode: ports.permissionMode,
    sourcePath: input.filePath,
  };
  const audit = (record: Omit<ArtifactAuditRecord, 'action' | 'runtime' | 'permissionMode' | 'timestamp' | 'sourcePath'> & { sourcePath?: string }) =>
    ports.audit({ ...base, ...record, sourcePath: record.sourcePath ?? base.sourcePath, timestamp: now().toISOString() });
  const userFacing = ports.userFacing === true; // UA12.54 — a PERSON reads the verdict (the preview click), not the model

  // 1. Unattended: refused before anything is read, counted or asked.
  const unattended = ports.unattendedReason();
  if (unattended) {
    audit({ decision: 'refused-unattended', rule: unattended });
    return refused(userFacing ? artifactUnattendedUserRefusal(unattended) : artifactUnattendedRefusal(unattended));
  }

  // 2. The request itself.
  if (input.retentionDays !== undefined && (!Number.isInteger(input.retentionDays)
    || input.retentionDays < PUBLISH_ARTIFACT_MIN_RETENTION_DAYS || input.retentionDays > PUBLISH_ARTIFACT_MAX_RETENTION_DAYS)) {
    audit({ decision: 'refused-request', rule: 'retention-range' });
    return refused(`retention_days must be a whole number from ${PUBLISH_ARTIFACT_MIN_RETENTION_DAYS} to `
      + `${PUBLISH_ARTIFACT_MAX_RETENTION_DAYS}; nothing was published. Omit it for ${PUBLISH_ARTIFACT_DEFAULT_RETENTION_DAYS} days. `
      + 'Longer or unlimited retention can only be set by the user in the app.');
  }
  let previous: ArtifactRegistryEntry | undefined;
  if (input.url !== undefined) {
    let id: string | undefined;
    try {
      id = isTArtifactsUrl(input.url) ? resolveArtifactId({ url: input.url }) : undefined;
    } catch {
      id = undefined;
    }
    try {
      previous = id ? findArtifactRegistryEntry(ports.workspaceRoot, id) : undefined;
    } catch (error) {
      audit({ decision: 'refused-request', rule: 'registry-unreadable' });
      return refused(error instanceof ArtifactRegistryError
        ? `${error.message} Nothing was published.`
        : 'The artifact registry could not be read; nothing was published.');
    }
    const ownTarget = previous !== undefined && previous.id === ports.registrySource?.updateTargetId; // UA6.7
    if (!previous || (previous.sourceSessionId === '' && !ownTarget) || previous.pendingDelete) { // UA1.19: a kept-for-deletion row is no target
      audit({ decision: 'refused-request', rule: 'unknown-update-target' });
      return refused(`${input.url} is not a page this workspace published, so it cannot be updated; nothing was sent. `
        + 'Publish a new page instead (omit url), or use list_artifacts to find this session\'s pages.');
    }
  }
  if (ports.cardPending()) {
    audit({ decision: 'refused-request', rule: 'card-pending' });
    return refused(userFacing
      ? 'A publish confirmation is already waiting in this session — answer it first; nothing was sent.'
      : 'A publish confirmation is already waiting for the user in this session; nothing was sent. '
        + 'Wait for that answer before publishing again.');
  }

  // 3. Guard → normalise → card → re-check; one more round when the file changed under the card.
  const readGuard = (): PublishGuardResult => ports.readSource?.() ?? guardArtifactFile({
    filePath: input.filePath,
    sessionCwd: ports.sessionCwd,
    ...(ports.sessionDir ? { sessionDir: ports.sessionDir } : {}),
    addedRoots: ports.addedRoots,
    permissionsContext: ports.permissionsContext ?? null,
  });
  for (let round = 0; round < 2; round++) {
    const guard = readGuard();
    if (!guard.ok) {
      audit({ decision: 'refused-guard', rule: guard.rule ?? guard.kind });
      return refused(guard.message);
    }
    const sourcePath = ports.registrySource?.sourcePath ?? artifactSourcePath(ports.sessionCwd, guard.realPath);
    let normalized: NormalizedArtifact;
    try {
      normalized = normalizeArtifact({
        fileName: guard.realPath,
        text: guard.text,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.emoji !== undefined ? { emoji: input.emoji } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    } catch (error) {
      const kind = error instanceof ArtifactClientError ? error.kind : 'invalid';
      audit({ decision: 'refused-guard', rule: `content-${kind}`, sourcePath, sha256: guard.sha256, byteLength: guard.byteLength });
      return refused(error instanceof Error ? error.message : 'The page could not be prepared; nothing was published.');
    }

    const retentionSent = action === 'create'
      ? (input.retentionDays ?? PUBLISH_ARTIFACT_DEFAULT_RETENTION_DAYS)
      : input.retentionDays;
    const expiresAt = retentionSent !== undefined ? addDays(now(), retentionSent) : (previous?.expiresAt ?? null);
    const ownerLogin = artifactOwnerLogin();
    const card = buildArtifactPublishCard({
      mode: action,
      sourcePath,
      guard,
      normalized,
      expiresAt,
      ...(ownerLogin !== undefined ? { ownerLogin } : {}),
      ...(retentionSent !== undefined ? { retentionDays: retentionSent } : {}),
      ...(input.url !== undefined ? { url: previous?.url ?? input.url } : {}),
      ...(previous ? { previous } : {}),
    });
    const facts = {
      sourcePath,
      sha256: guard.sha256,
      byteLength: normalized.byteLength,
      emailCount: guard.counts.emails,
      phoneCount: guard.counts.phones,
      scriptCount: card.scriptCount,
      externalHosts: card.externalHosts,
      ...(retentionSent !== undefined ? { retentionDays: retentionSent } : {}),
      ...(previous ? { url: previous.url } : {}),
    };

    const answer = await ports.raiseCard(card);
    if (!answer.allowed) {
      audit({ decision: 'denied', ...facts });
      return { status: 'denied', note: answer.refusal ?? `The publish of ${sourcePath} was declined; nothing was sent.` };
    }

    // The bytes approved are the bytes in the guard's buffer; if the FILE moved under the card, the person approved
    // something that is no longer the file, so nothing is sent and the new version gets a card of its own (once).
    const recheck = readGuard();
    if (!recheck.ok) {
      audit({ decision: 'refused-guard', rule: recheck.rule ?? recheck.kind, ...facts });
      return refused(`${sourcePath} changed after the card was shown: ${recheck.message}`);
    }
    if (recheck.sha256 !== guard.sha256) {
      if (round === 0) continue;
      audit({ decision: 'refused-guard', rule: 'changed-under-card', ...facts });
      return refused(`${sourcePath} changed again while its confirmation card was open, so nothing was sent. `
        + (userFacing ? 'Wait until the file has settled, then publish it again.' : 'Finish writing the page, then publish it once.'));
    }

    // 4. Send — exactly one request carrying the previewed bytes.
    const lineCount = card.lineCount;
    let record: ArtifactRecord;
    try {
      const client = ports.createClient();
      const request = {
        content: normalized.content,
        contentType: normalized.contentType,
        title: normalized.title,
        emoji: normalized.emoji,
        ...(normalized.description !== undefined ? { description: normalized.description } : {}),
        ...(retentionSent !== undefined ? { retentionDays: retentionSent } : {}),
      };
      record = previous
        ? await client.updateArtifact({ id: previous.id }, request)
        : await client.createArtifact(request);
    } catch (error) {
      const kind = error instanceof ArtifactClientError ? error.kind : 'network';
      audit({ decision: 'approved', failure: kind, ...facts });
      const message = error instanceof ArtifactClientError
        ? error.message
        : 'The artifact service could not be reached.';
      return {
        status: 'failed',
        note: userFacing
          ? `Publishing failed (${kind}): ${message} Nothing was published.`
          : `The user approved, but publishing failed (${kind}): ${message} Nothing was published.`,
      };
    }

    // P-UA-i-4 — the deployed service answers create and update WITHOUT `expires_at` (measured live on
    // RC4, S7-D 2026-10-10: the answer's expiry read null while this flow's own card had promised the
    // retention's date, and the service does expire the link) although the request carries
    // `retention_days` on every create. An answer without an expiry is displayed as the EXPECTATION:
    // the retention this flow asked for, else the registry's previous expiry on a retention-less
    // update — the note, the verdict and the registry never read "does not expire" while a retention
    // governs the link. The service divergence itself is a release-notes KNOWN line, not fixable here.
    record = {
      ...record,
      expiresAt: record.expiresAt
        ?? (retentionSent !== undefined ? addDays(now(), retentionSent) : (previous?.expiresAt ?? null)),
    };

    // 5. Registry (the map from artifact to session) and the audit row.
    try {
      if (previous) {
        recordArtifactUpdate(ports.workspaceRoot, {
          record,
          retentionSent: retentionSent !== undefined,
          contentDigest: guard.sha256,
          sourcePath,
          byteLength: normalized.byteLength,
          lineCount,
          ...(ports.registrySource?.page ? { page: ports.registrySource.page } : {}),
        });
      } else {
        recordArtifactPublish(ports.workspaceRoot, {
          record,
          sourceSessionId: ports.registrySource?.sourceSessionId ?? ports.sessionId,
          sourcePath,
          contentDigest: guard.sha256,
          kind: ports.registrySource?.kind ?? 'file',
          byteLength: normalized.byteLength,
          lineCount,
          ...(ports.registrySource?.page ? { page: ports.registrySource.page } : {}),
        });
      }
    } catch {
      // The page IS live; losing the registry row only loses this workspace's map to it. Said, not swallowed.
      audit({ decision: 'approved', ...facts, url: record.url, rule: 'registry-write-failed' });
      return {
        status: previous ? 'updated' : 'published',
        note: `Published at ${record.url}, but this workspace's artifact registry could not be written, so the page `
          + (userFacing ? 'will not appear in the workspace\'s list of published pages.' : 'will not appear in list_artifacts.'),
        url: record.url,
        expiresAt: record.expiresAt,
      };
    }
    // UA12.52 — the registry write landed (the catch above returned), so the workspace's windows learn it and an
    // OPEN Published pages section reloads without its Retry button.
    ports.notifyArtifactChanged?.();
    audit({ decision: 'approved', ...facts, url: record.url });
    const expiry = record.expiresAt ? `It expires on ${record.expiresAt}.` : 'It does not expire.';
    return {
      status: previous ? 'updated' : 'published',
      note: `${previous ? 'Updated' : 'Published'} ${sourcePath} at ${record.url}. ${expiry} Anyone with the link can open it.`,
      url: record.url,
      expiresAt: record.expiresAt,
    };
  }
  // Unreachable: round 1 either returns or refuses above.
  return refused('The page could not be published; nothing was sent.');
}

/** `list_artifacts`: the calling session's registry rows (id, title, url, expiresAt) — nothing else, no request. */
export function listSessionArtifactSummaries(workspaceRoot: string, sessionId: string): ListArtifactsResult {
  return {
    artifacts: listSessionArtifacts(workspaceRoot, sessionId).map(entry => ({
      id: entry.id,
      title: decodeBasicEntities(entry.title),
      url: entry.url,
      expiresAt: entry.expiresAt,
    })),
  };
}
