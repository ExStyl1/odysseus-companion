/**
 * Page Refresh Hook
 *
 * Bridges page configs into the automations engine: every page with a
 * `refresh` spec materializes as a synthetic cron matcher carrying a single
 * `script` action. The AutomationSystem merges these into its SchedulerTick
 * matchers, so page refreshes ride the exact same pipeline as user
 * automations (cron matching, script executor, history) — never an agent
 * session (deterministic, no token cost, no session-card spam).
 *
 * Synthetic matchers are rebuilt from disk via
 * AutomationSystem.reloadPageRefreshMatchers() — the config watcher's pages
 * branch triggers that on any page.json (or host-written refresh script) change.
 *
 * UA8.2 — copied from craft-agents-oss `v0.13.4:packages/shared/src/pages/refresh.ts` (Apache-2.0); the matcher id
 * helpers are verbatim. Our adaptations (spec §6 `pageRefresh`, §15 "Scheduled refresh", §16; reason (b): no
 * agent-authored path into scheduled execution):
 * 1. **The host writes the script, from CONTENT.** Upstream's agent-facing spec names a workspace-relative script
 *    PATH. Ours ({@link PageRefreshInputSchema}, strict) carries `scriptContent`; {@link setPageRefresh} writes it
 *    to `pages/<slug>/refresh.ts` ({@link pageRefreshScriptPath}) and stores THAT path in page.json, LAST. A `script`
 *    key is refused by the schema. page.json's own schema keeps upstream's `script` path (a hand-written file still
 *    parses), but a refresh whose `script` is not the host-written path never schedules ({@link pageRefreshAction}).
 *    Bun only, as upstream's tool schema (no `runtime` on the input).
 * 2. **Inert until a human approves its digest.** The approval is the MACed host-ledger entry `refresh-approval` /
 *    `page:<slug>` binding `{ path, sha256(bytes), args, runtime }` ({@link approvePageRefresh}, given in PageView
 *    through `pages:approveRefresh`, UA8.3). {@link buildPageRefreshMatchers} builds a matcher ONLY for a refresh
 *    whose current bytes match an approval, and the run re-verifies them (`ScriptHandler` passes this approval to
 *    `runApprovedScript`), so an edit between a reload and a tick is refused, never run. The review shows the whole
 *    binding (path, sha256 and text, args, runtime — {@link PageRefreshApproval}) and the approval names the sha256
 *    AND the args/runtime it showed, so a byte swap or an args-only change since the review is refused (UA8.3).
 * 3. **Managed policy (existing, spec §6), three arms:** the `enableScheduler` construction gate (no scheduler, no
 *    SchedulerTick, no refresh); `SessionManager`'s `subscribeManagedLocalAutomationChange` →
 *    `enforceManagedLocalAutomationPolicy`, which stops a running scheduler; and the use-time
 *    `isLocalAutomationManagedDisabled()` check inside `runApprovedScript` at every refresh dispatch (D1.409 shape).
 * Stated residues: the approval binds the script, not the schedule — an agent may change `cron` (within the 5-minute
 * floor), `timezone`, `timeoutMs` or `enabled` of an approved refresh without a new approval, but never what runs.
 * Network stays allowed (spec §15 item 6).
 */

import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { PageConfig, PageRefreshSpec } from '@nessy-agent/core';
import type { AutomationMatcher, ScriptAction, ScriptActionRuntime } from '../automations/types.ts';
import { scriptApprovalBinding, scriptApprovalRecord, scriptSha256 } from '../automations/script-executor.ts';
import {
  canonicalJson,
  findHostApproval,
  recordHostApproval,
  type HostApprovalKind,
  type HostApprovalsKeyProvider,
} from '../approvals/host-approvals.ts';
import { atomicWriteFileSync } from '../utils/files.ts';
import { loadPageConfig, loadWorkspacePages, updatePage } from './storage.ts';
import { PageRefreshSpecSchema, assertValidPageSlug } from './validation.ts';

/** Matcher-id prefix marking synthetic page-refresh matchers (also the history key) */
export const PAGE_REFRESH_MATCHER_PREFIX = 'page:';

/** Stable matcher/history id for a page's refresh automation */
export function pageRefreshMatcherId(pageSlug: string): string {
  return `${PAGE_REFRESH_MATCHER_PREFIX}${pageSlug}`;
}

/** True when a matcher id carries the page-refresh prefix — synthetic, or user-authored (UA12.96: such a matcher runs under the page's refresh approval) */
export function isPageRefreshMatcherId(matcherId: string): boolean {
  return matcherId.startsWith(PAGE_REFRESH_MATCHER_PREFIX);
}

// ============================================================
// NESSY — the host-written script and its approval (module header items 1–2)
// ============================================================

/** The file the host writes a page's refresh script to (Bun, as upstream's tool schema). */
export const PAGE_REFRESH_SCRIPT_FILENAME = 'refresh.ts';

/** The ledger kind a refresh approval is recorded under (`approvals/host-approvals.ts` names it). */
export const REFRESH_APPROVAL_KIND: HostApprovalKind = 'refresh-approval';

/** The ONLY script path a refresh may schedule: `pages/<slug>/refresh.ts`, workspace-relative, written by the host. */
export function pageRefreshScriptPath(pageSlug: string): string {
  assertValidPageSlug(pageSlug);
  return `pages/${pageSlug}/${PAGE_REFRESH_SCRIPT_FILENAME}`;
}

/** The ledger subject of a page's refresh approval (the matcher id: `page:<slug>`). */
export function pageRefreshApprovalSubject(pageSlug: string): string {
  return pageRefreshMatcherId(pageSlug);
}

/**
 * The refresh as an agent (or the pages RPC) supplies it: the script's CONTENT, never a path. Strict, so an
 * upstream-shaped `{ cron, script: "scripts/x.ts" }` is refused rather than silently stripped.
 */
export const PageRefreshInputSchema = z
  .object({
    cron: z.string().min(1, 'Cron expression cannot be empty'),
    scriptContent: z.string().min(1, 'scriptContent cannot be empty'),
    args: z.array(z.string()).optional(),
    timezone: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type PageRefreshInput = z.infer<typeof PageRefreshInputSchema>;

function issuesText(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ');
}

/**
 * Parse and validate a refresh input WITHOUT writing anything (the cron is checked exactly as page.json's schema
 * checks it: parses, fires, 5-minute floor). Throws `Invalid refresh: …`. Callers that create a page run this first,
 * so an invalid refresh fails the create before the page exists (upstream validates the whole config on write).
 */
export function parsePageRefreshInput(input: unknown): { scriptContent: string; spec: Omit<PageRefreshSpec, 'script'> } {
  const parsed = PageRefreshInputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid refresh: ${issuesText(parsed.error)}`);
  const { scriptContent, ...rest } = parsed.data;
  const spec: Omit<PageRefreshSpec, 'script'> = {
    cron: rest.cron,
    ...(rest.timezone !== undefined ? { timezone: rest.timezone } : {}),
    ...(rest.args !== undefined ? { args: rest.args } : {}),
    ...(rest.timeoutMs !== undefined ? { timeoutMs: rest.timeoutMs } : {}),
    ...(rest.enabled !== undefined ? { enabled: rest.enabled } : {}),
  };
  const checked = PageRefreshSpecSchema.safeParse({ ...spec, script: `pages/x/${PAGE_REFRESH_SCRIPT_FILENAME}` });
  if (!checked.success) throw new Error(`Invalid refresh: ${issuesText(checked.error)}`);
  return { scriptContent, spec };
}

/**
 * Set (or, with `null`, remove) a page's scheduled refresh. The host writes `pages/<slug>/refresh.ts` from the
 * content, then page.json LAST (the watcher's completion marker). Removing deletes the script file too. A new or
 * changed script is unapproved until a human approves its digest; the same bytes at the same binding stay approved.
 */
export function setPageRefresh(workspaceRootPath: string, pageSlug: string, input: unknown): PageConfig {
  if (!loadPageConfig(workspaceRootPath, pageSlug)) throw new Error(`Page not found: ${pageSlug}`);
  const scriptPath = pageRefreshScriptPath(pageSlug);
  if (input === null) {
    const updated = updatePage(workspaceRootPath, pageSlug, { refresh: null });
    rmSync(join(workspaceRootPath, scriptPath), { force: true });
    return updated;
  }
  const { scriptContent, spec } = parsePageRefreshInput(input);
  atomicWriteFileSync(join(workspaceRootPath, scriptPath), scriptContent);
  return updatePage(workspaceRootPath, pageSlug, { refresh: { ...spec, script: scriptPath } });
}

/**
 * The script action a page's refresh would run, or null when it has none, is paused (`enabled: false`), or names
 * a script other than the host-written one (module header item 1).
 */
export function pageRefreshAction(config: PageConfig): ScriptAction | null {
  const refresh = config.refresh;
  if (!refresh || refresh.enabled === false) return null;
  if (!refresh.cron || refresh.script !== pageRefreshScriptPath(config.slug)) return null;
  return {
    type: 'script',
    script: refresh.script,
    ...(refresh.args !== undefined ? { args: refresh.args } : {}),
    ...(refresh.runtime !== undefined ? { runtime: refresh.runtime } : {}),
    ...(refresh.timeoutMs !== undefined ? { timeoutMs: refresh.timeoutMs } : {}),
    page: config.slug,
  };
}

/**
 * Where a page's refresh stands against the ledger:
 * - `none` — no refresh, or it is paused;
 * - `foreign-script` — page.json names a script the host did not write; it never runs (set it again through
 *   `create_page` / `update_page`);
 * - `missing` — the host-written script file is gone;
 * - `unapproved` — no approval yet; `changed` — approved once, but the bytes (or args/runtime) differ now;
 * - `approved` — the current bytes are the approved ones.
 */
export type PageRefreshApprovalState = 'none' | 'foreign-script' | 'missing' | 'unapproved' | 'changed' | 'approved';

export interface PageRefreshApproval {
  state: PageRefreshApprovalState;
  /** The workspace-relative script path (host-written), when there is one. */
  script?: string;
  /** sha256 of the script's CURRENT bytes, when the file exists. */
  sha256?: string;
  /** The args the run passes — part of the binding an approval records (spec §15 item 3), so the review shows them. */
  args?: string[];
  /** The runtime the run uses (default `bun`) — part of the binding too. */
  runtime?: ScriptActionRuntime;
}

/** The args and runtime an approval binds besides the digest, as the review shows them and Approve names them. */
export interface PageRefreshReviewedBinding {
  args?: readonly string[];
  runtime?: string;
}

/** Read a page's refresh approval state with the ledger key (`getHostApprovalsKeyProvider().getKey()`). */
export function readPageRefreshApproval(workspaceRootPath: string, key: Buffer, config: PageConfig): PageRefreshApproval {
  if (!config.refresh || config.refresh.enabled === false) return { state: 'none' };
  const action = pageRefreshAction(config);
  if (!action) return { state: 'foreign-script', script: config.refresh.script };
  const { args, runtime } = scriptApprovalBinding(action);
  const absolute = join(workspaceRootPath, action.script);
  if (!existsSync(absolute)) return { state: 'missing', script: action.script, args, runtime };
  const sha256 = scriptSha256(readFileSync(absolute));
  const entry = findHostApproval(workspaceRootPath, key, REFRESH_APPROVAL_KIND, pageRefreshApprovalSubject(config.slug));
  if (!entry) return { state: 'unapproved', script: action.script, sha256, args, runtime };
  const expected = scriptApprovalRecord(action, sha256);
  const same = entry.digest === expected.digest && canonicalJson(entry.data ?? null) === canonicalJson(expected.data);
  return { state: same ? 'approved' : 'changed', script: action.script, sha256, args, runtime };
}

/**
 * Record the human's approval of a page's CURRENT refresh script (UA8.3's `pages:approveRefresh`). When the UI passes
 * the digest it showed, bytes that changed since are refused; when it passes the args and runtime it showed
 * (`expectedBinding`, absent fields read as the executor's defaults `[]` / `bun`), a binding that changed since is
 * refused too — the approval records `{ path, sha256, args, runtime }`, so the person approves what they saw, never
 * a swap of the bytes or of the args.
 */
export function approvePageRefresh(
  workspaceRootPath: string,
  key: Buffer,
  pageSlug: string,
  expectedSha256?: string,
  expectedBinding?: PageRefreshReviewedBinding,
): PageRefreshApproval {
  const config = loadPageConfig(workspaceRootPath, pageSlug);
  if (!config) throw new Error(`Page not found: ${pageSlug}`);
  if (!config.refresh) throw new Error(`Page ${pageSlug} has no scheduled refresh to approve`);
  const action = pageRefreshAction({ ...config, refresh: { ...config.refresh, enabled: true } });
  if (!action) {
    throw new Error(`Page ${pageSlug}'s refresh names a script the host did not write (${config.refresh.script}); set the refresh again through the page tools`);
  }
  const absolute = join(workspaceRootPath, action.script);
  if (!existsSync(absolute)) throw new Error(`Refresh script not found: ${action.script}`);
  const sha256 = scriptSha256(readFileSync(absolute));
  const { args, runtime } = scriptApprovalBinding(action);
  const bindingMoved = expectedBinding !== undefined
    && canonicalJson({ args: [...(expectedBinding.args ?? [])], runtime: expectedBinding.runtime ?? 'bun' }) !== canonicalJson({ args, runtime });
  if ((expectedSha256 !== undefined && expectedSha256 !== sha256) || bindingMoved) {
    throw new Error(`The refresh script of ${pageSlug} changed while it was being reviewed; review it again before approving`);
  }
  recordHostApproval(workspaceRootPath, key, {
    kind: REFRESH_APPROVAL_KIND,
    subject: pageRefreshApprovalSubject(pageSlug),
    ...scriptApprovalRecord(action, sha256),
  });
  return { state: 'approved', script: action.script, sha256, args, runtime };
}

/**
 * Build the synthetic SchedulerTick matchers for every page whose refresh is enabled, host-written AND approved at
 * its current bytes (module header item 2). Pure read — no caching; callers decide when to rebuild.
 */
export function buildPageRefreshMatchers(workspaceRootPath: string, key: Buffer): AutomationMatcher[] {
  const matchers: AutomationMatcher[] = [];

  for (const page of loadWorkspacePages(workspaceRootPath)) {
    const action = pageRefreshAction(page.config);
    if (!action) continue;
    if (readPageRefreshApproval(workspaceRootPath, key, page.config).state !== 'approved') continue;
    const refresh = page.config.refresh!;

    matchers.push({
      id: pageRefreshMatcherId(page.config.slug),
      name: `Page refresh: ${page.config.name}`,
      cron: refresh.cron,
      timezone: refresh.timezone,
      enabled: true,
      actions: [action],
    });
  }

  return matchers;
}

/**
 * {@link buildPageRefreshMatchers} for the AutomationSystem's reload: asks the ledger key ONLY when some page has a
 * schedulable refresh, so a workspace without one never touches the credential store.
 */
export async function loadPageRefreshMatchers(
  workspaceRootPath: string,
  keyProvider: HostApprovalsKeyProvider,
): Promise<AutomationMatcher[]> {
  if (!loadWorkspacePages(workspaceRootPath).some(page => pageRefreshAction(page.config) !== null)) return [];
  return buildPageRefreshMatchers(workspaceRootPath, await keyProvider.getKey());
}
