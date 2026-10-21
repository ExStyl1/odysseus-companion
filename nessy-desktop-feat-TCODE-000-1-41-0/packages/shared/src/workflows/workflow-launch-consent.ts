/**
 * Workflow launch consent — `workflows.md` §Approve the plan before it runs.
 *
 * Documented shape: "the per-run prompt shows the planned phases", with
 * "Yes, and don't ask again for `<name>` in `<path>`" as the remember, and the
 * Desktop card showing "the workflow name, the phase list, and a token-usage
 * caution, with Once, Always, and Deny actions".
 *
 * Two properties are load-bearing and easy to get wrong:
 *
 *  - This is a NORMAL, remember-able approval. It is deliberately NOT the
 *    `EnterWorktree`-style floor: an allow rule and a "don't ask again" both
 *    clear it, which is why the gate never marks it `nonNegotiable`.
 *  - The remember is scoped to BOTH the workflow and the project. The same
 *    workflow in another project prompts again, and another workflow in the
 *    same project prompts again. A single-axis record silently grants far more
 *    than the user agreed to.
 *
 * Denial is total: the launch never happens, so no agent is spawned and the
 * run has no side effect. That is enforced by the gate returning `block`
 * before the workflow tool executes at all, not by anything in this module.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { CONFIG_DIR } from '../config/paths.ts';
import { parseWorkflowRecipe, type WorkflowMeta } from './workflow-loader.ts';

export interface WorkflowLaunchPlan {
  /** The workflow's identity — `meta.name`, a saved name, or the fallback. */
  name: string;
  /** Ordered phase titles shown before anything runs. Empty is legitimate. */
  phases: string[];
}

const FALLBACK_WORKFLOW_NAME = 'workflow';
const MAX_LISTED_PHASES = 24;

function phaseTitles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const titles: string[] = [];
  for (const entry of value.slice(0, MAX_LISTED_PHASES)) {
    if (typeof entry === 'string' && entry.trim()) {
      titles.push(entry.trim());
      continue;
    }
    if (entry !== null && typeof entry === 'object' && typeof (entry as { title?: unknown }).title === 'string') {
      const title = (entry as { title: string }).title.trim();
      if (title) titles.push(title);
    }
  }
  return titles;
}

/** What a named-recipe lookup hands the plan: parsed meta, raw source, or both. */
export interface WorkflowLaunchRecipeResolution {
  meta?: WorkflowMeta;
  source?: string;
}

/**
 * What the user is about to approve, derived from the launch inputs alone.
 *
 * Precedence follows what the run will actually display: an explicit `phases`
 * argument wins, then the metadata of the script that will run. The script is
 * never evaluated — `parseWorkflowRecipe` reads `export const meta` as a pure
 * literal, so a consent prompt can never execute the thing it is gating.
 * A named recipe may resolve to already-parsed `meta` instead of source: the
 * loader's recipe store strips the `export const meta` statement from the
 * executable source, so re-parsing that body silently lost the declared phases
 * (the pass-8 "declares no phases up front" defect).
 *
 * A workflow with no resolvable metadata still yields a plan: the consent must
 * be shown for every launch, and "no declared phases" is an honest thing to
 * show rather than a reason to skip the prompt.
 */
export function resolveWorkflowLaunchPlan(
  input: Record<string, unknown>,
  resolveRecipe?: (name: string) => WorkflowLaunchRecipeResolution | undefined,
): WorkflowLaunchPlan {
  const requestedName = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined;
  const explicitPhases = phaseTitles(input.phases);

  let metaName: string | undefined;
  let metaPhases: string[] = [];
  const resolution: WorkflowLaunchRecipeResolution | undefined =
    typeof input.script === 'string' && input.script
      ? { source: input.script }
      : requestedName
        ? resolveRecipe?.(requestedName)
        : undefined;
  if (resolution?.meta) {
    metaName = resolution.meta.name;
    metaPhases = phaseTitles(resolution.meta.phases);
  } else if (resolution?.source) {
    try {
      const { meta } = parseWorkflowRecipe(resolution.source);
      metaName = meta.name;
      metaPhases = phaseTitles(meta.phases);
    } catch {
      // An unparseable script still launches (the tool reports the failure as a
      // structured result), so it still needs consent — just without phases.
    }
  }

  return {
    name: requestedName ?? metaName ?? FALLBACK_WORKFLOW_NAME,
    phases: explicitPhases.length > 0 ? explicitPhases : metaPhases,
  };
}

/**
 * The project half of the consent scope — the `<path>` in "don't ask again for
 * `<name>` in `<path>`".
 *
 * Exported and shared deliberately: the gate that READS the record lives in the
 * agent and the code that WRITES it lives in the session host. Two independent
 * derivations of this key would produce a remember that is stored under one
 * path and looked up under another, i.e. an approval that silently never takes
 * effect. There is exactly one derivation.
 */
export function workflowConsentProjectKey(input: {
  workingDirectory?: string;
  workspaceRootPath: string;
}): string {
  const workingDirectory = input.workingDirectory?.trim();
  return workingDirectory ? resolve(workingDirectory) : resolve(input.workspaceRootPath);
}

/** The consent text: the workflow name, its phase list, and the cost caution. */
export function describeWorkflowLaunchConsent(plan: WorkflowLaunchPlan): string {
  const phases = plan.phases.length > 0
    ? `Planned phases: ${plan.phases.join(' → ')}.`
    : 'This workflow declares no phases up front.';
  return `Run the workflow "${plan.name}"? ${phases}`
    + ' It orchestrates subagents in the background and can use substantially more tokens than one conversation.';
}

interface WorkflowLaunchConsentFile {
  version: 1;
  projects: Record<string, string[]>;
}

/**
 * The per-workflow-per-project "don't ask again" record.
 *
 * Deliberately a positive-only allowlist: there is no "denied forever" entry,
 * because a denial must not become durable without the user asking for it.
 * Every read failure — missing file, malformed JSON, unreadable directory —
 * resolves to "no consent recorded", so a broken record can only cause an
 * extra prompt, never a silent launch.
 */
export class WorkflowLaunchConsentStore {
  private readonly path: string;

  constructor(options: { path?: string } = {}) {
    this.path = options.path ?? join(CONFIG_DIR, 'workflow-launch-consent.json');
  }

  private read(): WorkflowLaunchConsentFile {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      const projects = (parsed as { projects?: unknown }).projects;
      if (projects === null || typeof projects !== 'object' || Array.isArray(projects)) throw new Error('shape');
      const normalized: Record<string, string[]> = {};
      for (const [project, names] of Object.entries(projects as Record<string, unknown>)) {
        if (!Array.isArray(names)) continue;
        normalized[project] = names.filter((name): name is string => typeof name === 'string');
      }
      return { version: 1, projects: normalized };
    } catch {
      return { version: 1, projects: {} };
    }
  }

  has(projectKey: string, workflowName: string): boolean {
    return this.read().projects[projectKey]?.includes(workflowName) === true;
  }

  remember(projectKey: string, workflowName: string): void {
    const file = this.read();
    const existing = file.projects[projectKey] ?? [];
    if (existing.includes(workflowName)) return;
    file.projects[projectKey] = [...existing, workflowName].sort();
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // A record we cannot persist means the next launch prompts again. That is
      // the safe failure direction, so it is swallowed rather than surfaced as
      // an error on an approval the user already granted.
    }
  }
}
